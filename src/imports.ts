// v1.1: after the testers wrote the tests, a program (not an AI) reads which modules each test imports and adds the
// dependencies the planner forgot. In the hard-target experiment one block's test imported another block's parser
// without depending on it, so both were built at the same time against different assumptions.

import * as path from 'node:path';
import type { BastionPlan } from './config.js';
import type { BastionMap } from './map.js';

/** Replace comments with spaces (newlines kept), leaving string / template literal contents untouched. */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    const nx = src[i + 1];
    if (ch === '/' && nx === '/') {
      while (i < n && src[i] !== '\n') { out += ' '; i++; }
    } else if (ch === '/' && nx === '*') {
      out += '  ';
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; }
      if (i < n) { out += '  '; i += 2; }
    } else if (ch === "'" || ch === '"' || ch === '`') {
      out += ch;
      i++;
      while (i < n && src[i] !== ch) {
        if (src[i] === '\\' && i + 1 < n) { out += src[i] + src[i + 1]; i += 2; continue; }
        if (src[i] === '\n' && ch !== '`') break; // unterminated line string: stop
        out += src[i];
        i++;
      }
      if (i < n && src[i] === ch) { out += ch; i++; }
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

const IMPORT_PATTERNS: RegExp[] = [
  /(?<![\w$.])import\s*(?:[^'"();]*?\s*from\s*)?(['"])([^'"\n]+)\1/g,
  /(?<![\w$.])import\s*\(\s*(['"])([^'"\n]+)\1\s*[,)]/g,
  /(?<![\w$.])export\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*(['"])([^'"\n]+)\1/g,
  /(?<![\w$.])require\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g,
];

/**
 * Relative module specifiers (starting with './' or '../') used by a JS/TS source, in source order, without duplicates:
 * static `import ... from '<spec>'`, side-effect `import '<spec>'`, `export ... from '<spec>'`, dynamic `import('<spec>')`
 * and `require('<spec>')` with a plain string literal ('...' or "..."). Bare specifiers ('node:fs', 'lodash') are left
 * out. Occurrences inside `//` or block comments are ignored.
 */
export function relativeImports(source: string): string[] {
  const clean = stripComments(source);
  const found: Array<{ at: number; spec: string }> = [];
  for (const re of IMPORT_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(clean)) !== null) {
      const spec = m[2];
      if (spec.startsWith('./') || spec.startsWith('../')) found.push({ at: m.index, spec });
    }
  }
  found.sort((a, b) => a.at - b.at);
  return [...new Set(found.map((f) => f.spec))];
}

/**
 * Repo-relative POSIX candidates a specifier may refer to, given the importing file (repo-relative; backslashes
 * accepted). The specifier is joined to the importing file's directory and normalised ('.' and '..' resolved).
 * Candidates, in this order, without duplicates: the path itself; when it ends in '.js': the same with '.ts', '.tsx',
 * '.mts'; when it ends in '.mjs': the same with '.mts'; when its last segment has no extension: the path plus each of
 * '.js', '.mjs', '.cjs', '.ts', '.tsx', and the path plus '/index.js', '/index.mjs', '/index.ts'.
 * A specifier that escapes the repo root (more '..' than directories) gives [].
 */
export function resolveImport(fromFile: string, spec: string): string[] {
  const dir = path.posix.dirname(fromFile.replace(/\\/g, '/'));
  const parts: string[] = [];
  for (const seg of `${dir === '.' ? '' : dir}/${spec}`.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return [];
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  if (parts.length === 0) return [];
  const p = parts.join('/');
  const out: string[] = [p];
  if (p.endsWith('.js')) {
    const stem = p.slice(0, -3);
    out.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`);
  } else if (p.endsWith('.mjs')) {
    out.push(`${p.slice(0, -4)}.mts`);
  } else if (path.posix.extname(parts[parts.length - 1]) === '') {
    for (const e of ['.js', '.mjs', '.cjs', '.ts', '.tsx']) out.push(p + e);
    for (const e of ['index.js', 'index.mjs', 'index.ts']) out.push(`${p}/${e}`);
  }
  return [...new Set(out)];
}

export interface MissingDep {
  /** Node whose test needs something. */
  node: string;
  /** Node that owns the imported file. */
  needs: string;
  /** The imported file (as listed in the owner's `files`). */
  via: string;
}

/**
 * `tests` maps a test file path (as in node.testFile; compare with forward slashes) to its content; nodes whose test
 * file is absent from `tests` are skipped. For every node, each file its test imports (relativeImports + resolveImport;
 * the first candidate that some node lists in `files` wins) that is owned by ANOTHER node which the node does not
 * already depend on directly or transitively gives one MissingDep - at most one per (node, needs) pair, with the first
 * `via` found. Results follow map node order, then import order.
 * An edge that would close a cycle (the owner already depends, directly or transitively, on the node - also counting
 * edges added earlier in this same call) is not added to `missing` but reported in `cycles`.
 */
export function findMissingDeps(map: BastionMap, tests: Record<string, string>): { missing: MissingDep[]; cycles: MissingDep[] } {
  const norm = (f: string): string => f.replace(/\\/g, '/').replace(/^\.\//, '');
  const normTests = new Map<string, string>();
  for (const [k, v] of Object.entries(tests)) normTests.set(norm(k), v);

  const owner = new Map<string, string>();
  for (const n of map.nodes) for (const f of n.files) if (!owner.has(norm(f))) owner.set(norm(f), n.id);

  const edges = new Map<string, Set<string>>();
  for (const n of map.nodes) edges.set(n.id, new Set(n.dependsOn ?? []));
  const reaches = (from: string, target: string): boolean => {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (cur === target) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const d of edges.get(cur) ?? []) stack.push(d);
    }
    return false;
  };

  const missing: MissingDep[] = [];
  const cycles: MissingDep[] = [];
  const done = new Set<string>();
  for (const n of map.nodes) {
    const src = normTests.get(norm(n.testFile));
    if (src === undefined) continue;
    const testPath = norm(n.testFile);
    for (const spec of relativeImports(src)) {
      let via: string | undefined;
      let needs: string | undefined;
      for (const cand of resolveImport(testPath, spec)) {
        const o = owner.get(cand);
        if (o !== undefined) { via = cand; needs = o; break; }
      }
      if (via === undefined || needs === undefined || needs === n.id) continue;
      if (reaches(n.id, needs)) continue; // already depends (directly or transitively)
      const key = `${n.id}\u0000${needs}`;
      if (done.has(key)) continue;
      done.add(key);
      if (reaches(needs, n.id)) {
        cycles.push({ node: n.id, needs, via });
      } else {
        missing.push({ node: n.id, needs, via });
        edges.get(n.id)!.add(needs);
      }
    }
  }
  return { missing, cycles };
}

/**
 * A copy of the plan (input untouched) where each missing dependency is appended to the dependsOn of the plan node with
 * id `node` (created when absent; no duplicates; unknown node ids ignored). Nodes without additions are returned as is.
 */
export function addDepsToPlan(plan: BastionPlan, missing: MissingDep[]): BastionPlan {
  return {
    ...plan,
    nodes: plan.nodes.map((n) => {
      const add = missing.filter((m) => m.node === n.id).map((m) => m.needs);
      if (add.length === 0) return n;
      return { ...n, dependsOn: [...new Set([...(n.dependsOn ?? []), ...add])] };
    }),
  };
}
