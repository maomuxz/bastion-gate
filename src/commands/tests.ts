import * as fs from 'node:fs';
import * as path from 'node:path';
import { LOCK_REL_PATH, PLAN_REL_PATH, readConfigFromDisk, readPlanFromDisk, writePlanToDisk } from '../config.js';
import { execGit, getRepoRoot, gitIdentityArgs } from '../git.js';
import { addDepsToPlan, findMissingDeps } from '../imports.js';
import { INTERFACES_REL_PATH, readMap } from '../map.js';
import type { MapNode } from '../map.js';
import { resolveAgentCommand, runRole } from '../roles.js';
import { GAPS_MD_REL_PATH, listTestCases, renderGapsMarkdown } from '../gaps.js';
import type { Gap } from '../gaps.js';
import { writeText } from '../map.js';
import { findGaps } from './gaps.js';
import { runLock } from './lock.js';
import type { TestsOptions } from './stages.js';

function requirementSection(requirement: string | null): string[] {
  if (requirement === null) return [];
  return [
    '## Original requirement (source of truth)',
    requirement,
    '',
    'Where the interfaces or acceptance sentences omit or contradict a rule of the requirement that concerns this node, the requirement wins and the rule must be tested.',
    '',
  ];
}

function buildGapPrompt(requirement: string, interfaces: string, node: MapNode, gaps: Gap[]): string {
  return [
    `You are the tester for node "${node.id}" (${node.title}). A critic found requirement rules that no test checks.`,
    '',
    ...requirementSection(requirement),
    '## Shared interfaces (interfaces.md)',
    interfaces,
    '',
    `## Interface of node ${node.id}`,
    node.interface,
    '',
    `Existing test file: ${node.testFile}`,
    `Test command that will run it: ${node.testCommand}`,
    '',
    '## Missing rules',
    ...gaps.flatMap((g) => [`- ${g.rule}`, `  > ${g.quote}`]),
    '',
    `Add tests for these rules to the existing file ${node.testFile}. Do not remove or weaken any existing test. Edit no other file.`,
    '',
  ].join('\n');
}

function buildPrompt(interfaces: string, node: MapNode, requirement: string | null = null): string {
  return [
    `You are the tester for node "${node.id}" (${node.title}).`,
    '',
    'Write the acceptance test file for this node. Write exactly one file and do not edit any other file.',
    `Test file to write: ${node.testFile}`,
    `Test command that will run it: ${node.testCommand}`,
    '',
    'The tests must exercise only the public interface below and must fail until the implementation is real.',
    'Every acceptance sentence must be covered by at least one test.',
    '',
    ...requirementSection(requirement),
    '## Shared interfaces (interfaces.md)',
    interfaces,
    '',
    `## Interface of node ${node.id}`,
    node.interface,
    '',
    `## Acceptance of node ${node.id}`,
    ...node.acceptance.map((a) => `- ${a}`),
    '',
    `Write the tests to ${node.testFile} now.`,
    '',
  ].join('\n');
}

/**
 * P4 `bastion tests [--lock] [--no-gaps]`: for every map node, call the tester role (up to `concurrency` at once, default 2)
 * with interfaces.md, the node's interface, acceptance and testFile; the tester must write exactly that test file.
 * A missing/empty test file -> 1. Commits the test files ("test(bastion): acceptance tests"). With lock: runs
 * runLock (amend with reason "bastion tests" when a lock already exists) and commits .bastion/lock.json; returns its result.
 *
 * v1.1 - requirement reaches the tester: when .bastion/requirement.md exists and is not blank, every tester prompt also
 * contains a section headed `## Original requirement (source of truth)` with its text verbatim, and says that where the
 * interfaces or acceptance sentences omit or contradict a rule of the requirement that concerns this node, the requirement
 * wins and the rule must be tested. Without the file the prompt is unchanged.
 *
 * v1.1 - gap check before locking: when `lock` is set, `gaps` is not false, and the requirement file exists (not blank),
 * then after all testers succeeded and BEFORE the test commit: call findGaps(repoRoot, { testFiles }).
 *  - !ok -> print `[bastion] tests: gap check failed: <error>` to stderr and return 1 (nothing committed, nothing locked).
 *  - no kept gap -> write .bastion/gaps.md and go on.
 *  - kept gaps -> group them by node: a gap whose `file` equals a node's testFile (compare with forward slashes) goes to
 *    that node, any other gap goes to the first map node. For each such node call the tester role once more, sequentially,
 *    with label `tests-<id>-gaps`; that prompt contains the requirement section, the interfaces, the node interface, the
 *    path of the existing test file, the list of missing rules with their quotes, and says: add tests for these rules to
 *    the existing file, do not remove or weaken any existing test, edit no other file. Afterwards the file must differ
 *    from before and listTestCases must not return fewer cases than before; a failing tester, an unchanged file or fewer
 *    cases -> stderr message and return 1. Then write .bastion/gaps.md with the note
 *    `Patched by the tester: <comma-separated node ids>. The patch was not re-checked by the critic.`
 * v1.1 - dependency scan: after the testers (and any gap patch) and before the test commit, when .bastion/plan.json
 * exists: findMissingDeps(map, contents of the node test files) from src/imports.ts. For every missing dependency the
 * plan is extended (addDepsToPlan, written back to .bastion/plan.json) and a line
 * `[bastion] tests: added dependency <node> -> <needs> (its test imports <via>).` is printed; plan.json then goes into
 * the same commit as the test files. Every cycle is reported on stderr as
 * `[bastion] tests: the test of <node> imports <via> owned by <needs>, but <needs> depends on <node>; fix the map.` and
 * is not fatal. .bastion/map.json is never changed (the approval stays valid). This runs with and without `lock`.
 *
 * v1.1 - every commit made here passes gitIdentityArgs(repoRoot) (src/git.ts) before the `commit` subcommand.
 *
 *  The critic is called once per run (no second pass). gaps.md is committed together with the lock when it is not
 *  gitignored. Without `lock`, or with gaps === false, or without a requirement file, no critic call happens.
 */
/*
 * v1.1 hardening (round 5) - "a skipped or failed wall step must never look like a pass". These rules replace the
 * older wording above wherever they differ.
 * (H1) lock requested, gaps not disabled (opts.gaps !== false), but .bastion/requirement.md is missing or blank:
 *      no critic is called (as before), and the skip is now loud and recorded: stderr gets
 *      `[bastion] tests: no .bastion/requirement.md - the gap check was skipped; locking without it.` and
 *      .bastion/gaps.md is written with exactly
 *      `# Gap check\n\nSkipped: no .bastion/requirement.md, so there was nothing to check the tests against.\n`
 *      and committed together with the lock like a normal gaps.md (when git does not ignore it). Exit code as before.
 *      With opts.gaps === false nothing is printed and gaps.md is not touched.
 * (H2) After each gap-patch tester call (label tests-<id>-gaps), before anything is committed or locked:
 *      - the node's test file must still contain every test case name it had before (listTestCases); otherwise stderr
 *        `[bastion] tests: gap patch for <id> removed test case(s) from <file>: <names joined by ', '>.` and return 1;
 *      - it must contain strictly more cases than before; otherwise stderr
 *        `[bastion] tests: gap patch for <id> added no test case to <file>.` and return 1 (this also covers an
 *        unchanged file and a comment-only change; the older "left ... unchanged" message is no longer used);
 *      - every other test file of the map must be byte-identical to what it was before this tester call; otherwise
 *        stderr `[bastion] tests: gap patch for <id> changed another node's test file: <that file>.` and return 1.
 *      The note in gaps.md becomes
 *      `Patched by the tester: <ids joined by ', '> (<n> new case(s)). The patch was not re-checked by the critic.`
 *      where n is the total number of cases added over all patched files.
 * (H3) Dependency scan: any exception (unreadable plan, write failure...) prints
 *      `[bastion] tests: dependency scan failed: <message>` to stderr and returns 1 - nothing is committed or locked.
 *      A reported cycle (the existing "fix the map" line) also returns 1 after all cycle lines were printed.
 */
export async function runTests(opts: TestsOptions): Promise<number> {
  const repoRoot = getRepoRoot(opts.cwd);
  if (!repoRoot) {
    console.error('[bastion] Error: not inside a git repository.');
    return 1;
  }
  let config;
  try {
    config = readConfigFromDisk(repoRoot);
  } catch (e) {
    console.error(`[bastion] Error: ${(e as Error).message}`);
    return 1;
  }
  const map = readMap(repoRoot);
  if (!map) {
    console.error('[bastion] Error: .bastion/map.json is missing or unreadable. Run "bastion map" first.');
    return 1;
  }
  const command = resolveAgentCommand(config, 'tester');
  if (!command) {
    console.error('[bastion] Error: no tester command configured (roles.tester or agentCommand).');
    return 1;
  }
  const ifacePath = path.join(repoRoot, INTERFACES_REL_PATH);
  const interfaces = fs.existsSync(ifacePath) ? fs.readFileSync(ifacePath, 'utf8') : map.interfaces;
  const timeoutMs = opts.timeoutMinutes && opts.timeoutMinutes > 0 ? opts.timeoutMinutes * 60_000 : undefined;
  const limit = Math.max(1, Math.floor(opts.concurrency ?? 2));

  const reqPath = path.join(repoRoot, '.bastion', 'requirement.md');
  const reqText = fs.existsSync(reqPath) ? fs.readFileSync(reqPath, 'utf8') : '';
  const requirement = reqText.trim() === '' ? null : reqText.replace(/\s+$/, '');

  const nodes = map.nodes;
  const failed = new Set<string>();
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < nodes.length) {
      const node = nodes[next++];
      const res = await runRole(command, 'tester', {
        prompt: buildPrompt(interfaces, node, requirement),
        cwd: repoRoot,
        repoRoot,
        label: `tests-${node.id}`,
        timeoutMs,
      });
      const full = path.join(repoRoot, node.testFile);
      const written = fs.existsSync(full) && fs.statSync(full).isFile() && fs.statSync(full).size > 0;
      if (res.exitCode !== 0) {
        console.error(`[bastion] tests: tester for ${node.id} ${res.timedOut ? 'timed out' : `exited ${res.exitCode}`}.`);
        failed.add(node.id);
      } else if (!written) {
        console.error(`[bastion] tests: tester for ${node.id} did not write ${node.testFile} (missing or empty).`);
        failed.add(node.id);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, nodes.length) }, () => worker()));
  if (failed.size > 0) {
    console.error(`[bastion] tests: failed for node(s): ${[...failed].join(', ')}.`);
    return 1;
  }

  const testFiles = [...new Set(nodes.map((n) => n.testFile.replace(/\\/g, '/')))];
  const commit = (files: string[], message: string): boolean => {
    const add = execGit(['add', '--', ...files], repoRoot);
    if (!add.ok) {
      console.error(`[bastion] tests: git add failed: ${add.stderr}`);
      return false;
    }
    const staged = execGit(['diff', '--cached', '--quiet', '--', ...files], repoRoot);
    if (staged.ok) return true; // nothing to commit
    const res = execGit([...gitIdentityArgs(repoRoot), 'commit', '-m', message, '--', ...files], repoRoot);
    if (!res.ok) {
      console.error(`[bastion] tests: git commit failed: ${res.stderr || res.stdout}`);
      return false;
    }
    return true;
  };
  const norm = (f: string): string => f.replace(/\\/g, '/');
  let gapsFile: string | null = null;
  if (opts.lock && opts.gaps !== false && requirement !== null) {
    const res = await findGaps(repoRoot, { timeoutMinutes: opts.timeoutMinutes, testFiles });
    if (!res.ok) {
      console.error(`[bastion] tests: gap check failed: ${res.error ?? 'unknown error'}`);
      return 1;
    }
    let note: string | undefined;
    if (res.kept.length > 0) {
      const byNode = new Map<string, Gap[]>();
      for (const g of res.kept) {
        const owner = (g.file !== undefined ? nodes.find((n) => norm(n.testFile) === norm(g.file!)) : undefined) ?? nodes[0];
        byNode.set(owner.id, [...(byNode.get(owner.id) ?? []), g]);
      }
      const patched: string[] = [];
      let added = 0;
      for (const node of nodes) {
        const gs = byNode.get(node.id);
        if (!gs) continue;
        const full = path.join(repoRoot, node.testFile);
        const beforeSrc = fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : '';
        const snapshot = new Map<string, Buffer | null>();
        for (const f of testFiles) {
          const fp = path.join(repoRoot, f);
          snapshot.set(f, fs.existsSync(fp) ? fs.readFileSync(fp) : null);
        }
        const r = await runRole(command, 'tester', {
          prompt: buildGapPrompt(requirement, interfaces, node, gs),
          cwd: repoRoot,
          repoRoot,
          label: `tests-${node.id}-gaps`,
          timeoutMs,
        });
        if (r.exitCode !== 0) {
          console.error(`[bastion] tests: gap patch tester for ${node.id} ${r.timedOut ? 'timed out' : `exited ${r.exitCode}`}.`);
          return 1;
        }
        const afterSrc = fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : '';
        const beforeNames = listTestCases(beforeSrc);
        const afterNames = listTestCases(afterSrc);
        const remaining = new Map<string, number>();
        for (const n of afterNames) remaining.set(n, (remaining.get(n) ?? 0) + 1);
        const removed: string[] = [];
        for (const n of beforeNames) {
          const c = remaining.get(n) ?? 0;
          if (c > 0) remaining.set(n, c - 1);
          else removed.push(n);
        }
        if (removed.length > 0) {
          console.error(`[bastion] tests: gap patch for ${node.id} removed test case(s) from ${node.testFile}: ${removed.join(', ')}.`);
          return 1;
        }
        if (afterNames.length <= beforeNames.length) {
          console.error(`[bastion] tests: gap patch for ${node.id} added no test case to ${node.testFile}.`);
          return 1;
        }
        for (const f of testFiles) {
          if (norm(f) === norm(node.testFile)) continue;
          const fp = path.join(repoRoot, f);
          const now = fs.existsSync(fp) ? fs.readFileSync(fp) : null;
          const was = snapshot.get(f) ?? null;
          const same = now === null || was === null ? now === was : now.equals(was);
          if (!same) {
            console.error(`[bastion] tests: gap patch for ${node.id} changed another node's test file: ${f}.`);
            return 1;
          }
        }
        added += afterNames.length - beforeNames.length;
        patched.push(node.id);
      }
      note = `Patched by the tester: ${patched.join(', ')} (${added} new case(s)). The patch was not re-checked by the critic.`;
    }
    writeText(repoRoot, GAPS_MD_REL_PATH, renderGapsMarkdown(res.kept, res.discarded, note));
    if (!execGit(['check-ignore', '-q', '--', GAPS_MD_REL_PATH], repoRoot).ok) gapsFile = GAPS_MD_REL_PATH;
  } else if (opts.lock && opts.gaps !== false) {
    console.error('[bastion] tests: no .bastion/requirement.md - the gap check was skipped; locking without it.');
    writeText(repoRoot, GAPS_MD_REL_PATH, '# Gap check\n\nSkipped: no .bastion/requirement.md, so there was nothing to check the tests against.\n');
    if (!execGit(['check-ignore', '-q', '--', GAPS_MD_REL_PATH], repoRoot).ok) gapsFile = GAPS_MD_REL_PATH;
  }

  const commitFiles = [...testFiles];
  if (fs.existsSync(path.join(repoRoot, PLAN_REL_PATH))) {
    try {
      const plan = readPlanFromDisk(repoRoot);
      const contents: Record<string, string> = {};
      for (const f of testFiles) {
        const full = path.join(repoRoot, f);
        if (fs.existsSync(full)) contents[f] = fs.readFileSync(full, 'utf8');
      }
      const { missing, cycles } = findMissingDeps(map, contents);
      for (const c of cycles) {
        console.error(`[bastion] tests: the test of ${c.node} imports ${c.via} owned by ${c.needs}, but ${c.needs} depends on ${c.node}; fix the map.`);
      }
      if (missing.length > 0) {
        writePlanToDisk(repoRoot, addDepsToPlan(plan, missing));
        for (const m of missing) {
          console.log(`[bastion] tests: added dependency ${m.node} -> ${m.needs} (its test imports ${m.via}).`);
        }
        commitFiles.push(PLAN_REL_PATH);
      }
      if (cycles.length > 0) return 1;
    } catch (e) {
      console.error(`[bastion] tests: dependency scan failed: ${(e as Error).message}`);
      return 1;
    }
  }

  if (!commit(commitFiles, 'test(bastion): acceptance tests')) return 1;

  if (!opts.lock) return 0;

  const amend = fs.existsSync(path.join(repoRoot, LOCK_REL_PATH));
  const code = runLock(amend
    ? { cwd: repoRoot, amend: true, reason: 'bastion tests', extraFiles: testFiles }
    : { cwd: repoRoot, extraFiles: testFiles });
  if (code !== 0) return code;
  return commit(gapsFile ? [LOCK_REL_PATH, gapsFile] : [LOCK_REL_PATH], 'test(bastion): lock acceptance tests') ? 0 : 1;
}
