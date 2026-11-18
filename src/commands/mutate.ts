import * as fs from 'node:fs';
import * as path from 'node:path';
import { readConfigFromDisk } from '../config.js';
import { getDirtyFiles, getRepoRoot, resolveRef, toPosixPath } from '../git.js';
import { createNodeWorktree, removeNodeWorktree, WorktreeHandle } from '../orchestrator/worktree.js';
import { matchesAnyGlob, runTestCommand, walkRepoFiles } from '../runner.js';

export interface MutateOptions {
  cwd: string;
  files?: string[];
  maxMutations?: number;
}

interface Mutant {
  file: string;
  line: number;
  description: string;
  mutatedContent: string;
}

const SOURCE_EXTENSIONS = new Set(['.ts', '.js', '.mjs', '.cjs', '.py', '.go', '.rs', '.dart']);
const DEFAULT_MUTATE_EXCLUDE = [
  'scripts/**',
  'examples/**',
  'demo/**',
  'docs/**',
  'dist/**',
  'dist-test/**',
  'build/**',
  'vendor/**',
  '.bastion/**',
  '**/*.config.*',
];

const MUTATION_RULES: Array<{ pattern: RegExp; replace: string; label: string }> = [
  { pattern: /===/, replace: '!==', label: '=== -> !==' },
  { pattern: /!==/, replace: '===', label: '!== -> ===' },
  { pattern: />=/, replace: '<', label: '>= -> <' },
  { pattern: /<=/, replace: '>', label: '<= -> >' },
  { pattern: /\btrue\b/, replace: 'false', label: 'true -> false' },
  { pattern: /\bfalse\b/, replace: 'true', label: 'false -> true' },
];

/**
 * Which lines may be mutated (v1.0, F11): true for lines containing code. False for blank lines, `import ...` lines,
 * lines that are entirely a `//` or `#` comment, and every line inside or touching only a block comment
 * (from the line with `/*` or `/**` through the line with the closing `*\/`), including JSDoc lines starting with `*`.
 * A line with code before a block comment opens (e.g. `x = 1; /* note`) is code; the following comment lines are not.
 * Returns one boolean per input line.
 */
export function codeLineMask(lines: string[]): boolean[] {
  let inBlock = false;
  return lines.map((line) => {
    let i = 0;
    let hasCode = false;
    if (!inBlock) {
      const t = line.trim();
      if (!t || t.startsWith('//') || t.startsWith('#') || t.startsWith('import ')) return false;
    }
    let quote = '';
    while (i < line.length) {
      if (inBlock) {
        const end = line.indexOf('*/', i);
        if (end < 0) return hasCode;
        inBlock = false;
        i = end + 2;
        continue;
      }
      const ch = line[i];
      if (quote) {
        hasCode = true;
        if (ch === '\\') i++;
        else if (ch === quote) quote = '';
        i++;
        continue;
      }
      if (ch === '/' && line[i + 1] === '*') {
        inBlock = true;
        i += 2;
        continue;
      }
      if (ch === '/' && line[i + 1] === '/') break;
      if (ch === '"' || ch === "'" || ch === '`') quote = ch;
      if (ch.trim()) hasCode = true;
      i++;
    }
    return hasCode;
  });
}

function collectMutantsForFile(relPath: string, content: string): Mutant[] {
  const lines = content.split('\n');
  const mutants: Mutant[] = [];
  const mask = codeLineMask(lines);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!mask[i]) continue;

    for (const rule of MUTATION_RULES) {
      if (!rule.pattern.test(line)) continue;
      const mutatedLine = line.replace(rule.pattern, rule.replace);
      if (mutatedLine === line) continue;

      const copy = [...lines];
      copy[i] = mutatedLine;
      mutants.push({
        file: relPath,
        line: i + 1,
        description: rule.label,
        mutatedContent: copy.join('\n'),
      });
    }
  }

  return mutants;
}

/** Pick up to `max` mutants evenly across files (round-robin) so one file cannot starve others. */
function sampleMutantsRoundRobin(perFile: Mutant[][], max: number): Mutant[] {
  const selected: Mutant[] = [];
  const cursors = new Array(perFile.length).fill(0);
  let progressed = true;

  while (selected.length < max && progressed) {
    progressed = false;
    for (let i = 0; i < perFile.length && selected.length < max; i++) {
      if (cursors[i] < perFile[i].length) {
        selected.push(perFile[i][cursors[i]++]);
        progressed = true;
      }
    }
  }
  return selected;
}

/**
 * Lightweight mutation spot-check: runs inside an isolated temporary worktree
 * (when clean git HEAD exists) so user source files are never left dirty even on Ctrl+C.
 */
export function runMutate(opts: MutateOptions): number {
  const repoRoot = getRepoRoot(opts.cwd) ?? path.resolve(opts.cwd);
  const config = readConfigFromDisk(repoRoot);
  const maxMutations = opts.maxMutations ?? 10;

  const lockedPatterns = [...config.lockedGlobs, ...config.extraLockedPaths];
  const excludePatterns = [...DEFAULT_MUTATE_EXCLUDE, ...(config.mutateExclude ?? [])];

  const candidateFiles = opts.files && opts.files.length > 0
    ? opts.files.map(toPosixPath)
    : walkRepoFiles(repoRoot).filter((rel) => {
        const ext = path.extname(rel);
        return (
          SOURCE_EXTENSIONS.has(ext) &&
          !matchesAnyGlob(rel, excludePatterns) &&
          !matchesAnyGlob(rel, lockedPatterns)
        );
      });

  // Use an isolated worktree if git HEAD exists and working tree is clean
  const head = resolveRef('HEAD', repoRoot);
  const canUseWorktree = Boolean(head && getDirtyFiles(repoRoot).length === 0);
  let workHandle: WorktreeHandle | null = null;
  let execRoot = repoRoot;

  if (canUseWorktree && head) {
    const id = `mutate-${Date.now().toString(36)}`;
    workHandle = createNodeWorktree(repoRoot, head, id);
    execRoot = workHandle.dir;
  }

  try {
    const baseline = runTestCommand(config.testCommand, execRoot);
    if (baseline.exitCode !== 0) {
      console.error(`[bastion] Mutation aborted: baseline testCommand already fails (exit ${baseline.exitCode}).`);
      return 1;
    }

    const perFileMutants: Mutant[][] = [];
    for (const rel of candidateFiles) {
      const full = path.join(execRoot, rel);
      if (!fs.existsSync(full)) continue;
      const content = fs.readFileSync(full, 'utf8');
      const m = collectMutantsForFile(rel, content);
      if (m.length > 0) perFileMutants.push(m);
    }

    const allMutants = sampleMutantsRoundRobin(perFileMutants, maxMutations);
    if (allMutants.length === 0) {
      console.log('[bastion] No mutation points found in target source files.');
      return 0;
    }

    console.log(`[bastion] Running ${allMutants.length} mutation spot-check(s)${workHandle ? ' (in isolated worktree)' : ''}...`);
    let killed = 0;
    const survived: Mutant[] = [];

    for (const mutant of allMutants) {
      const full = path.join(execRoot, mutant.file);
      const original = fs.readFileSync(full, 'utf8');
      try {
        fs.writeFileSync(full, mutant.mutatedContent, 'utf8');
        const res = runTestCommand(config.testCommand, execRoot);
        if (res.exitCode !== 0) {
          killed++;
          console.log(`  [KILLED]   ${mutant.file}:${mutant.line} (${mutant.description})`);
        } else {
          survived.push(mutant);
          console.error(`  [SURVIVED] ${mutant.file}:${mutant.line} (${mutant.description}) — tests still passed!`);
        }
      } finally {
        fs.writeFileSync(full, original, 'utf8');
      }
    }

    console.log(`\n[bastion] Mutation score: ${killed}/${allMutants.length} killed.`);
    if (survived.length > 0) {
      console.error('[bastion] Some mutations survived — tests may have blind spots.');
      return 1;
    }
    return 0;
  } finally {
    if (workHandle) {
      removeNodeWorktree(repoRoot, workHandle);
    }
  }
}
