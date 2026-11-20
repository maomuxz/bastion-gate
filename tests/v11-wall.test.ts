// v1.1 - the wall: the kernel (lock, gaps, gate, qa, audit) must not import any add-on, and it must work standalone
// (no map, no plan, no run-state). Contract: src/wall.ts and the "v1.1 kernel rule" paragraphs of gaps.ts / qa.ts.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'node:test';
import { runLock } from '../src/commands/lock.js';
import { findGaps } from '../src/commands/gaps.js';
import { runQa } from '../src/commands/qa.js';
import * as wall from '../src/wall.js';
import { KERNEL_FORBIDDEN_IMPORTS, KERNEL_MODULES } from '../src/wall.js';
import { captureConsole, cleanupTempRepos, git, readJson, writeRepoFile } from './v04-helpers.js';
import { createRoleRepo, readRoleCalls } from './v1-helpers.js';

afterEach(cleanupTempRepos);

// ---------------------------------------------------------------- (1) import graph

function findRepoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'src'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error('repo root (package.json) not found above the compiled test file');
}
const ROOT = findRepoRoot();
const rel = (abs: string) => path.relative(ROOT, abs).split(path.sep).join('/');

/** Relative import / export-from specifiers of a TypeScript source (type imports and side-effect imports included). */
function relativeImports(source: string): string[] {
  const noComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const found: string[] = [];
  const fromRe = /\b(?:import|export)\b[^;'"]*?\bfrom\s*['"](\.{1,2}\/[^'"]+)['"]/g;
  const bareRe = /\bimport\s*['"](\.{1,2}\/[^'"]+)['"]/g;
  const dynRe = /\bimport\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;
  for (const re of [fromRe, bareRe, dynRe]) for (const m of noComments.matchAll(re)) found.push(m[1]!);
  return found;
}

/** All files reachable from `start` (repo-relative paths), with the chain that reached each one. */
function reachable(start: string): Map<string, string[]> {
  const seen = new Map<string, string[]>([[start, [start]]]);
  const queue = [start];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const abs = path.join(ROOT, cur);
    if (!fs.existsSync(abs)) continue;
    for (const spec of relativeImports(fs.readFileSync(abs, 'utf8'))) {
      const target = rel(path.resolve(path.dirname(abs), spec.replace(/\.js$/, '.ts')));
      if (seen.has(target)) continue;
      seen.set(target, [...seen.get(cur)!, target]);
      queue.push(target);
    }
  }
  return seen;
}

describe('v1.1 wall: import graph', () => {
  it('the import scanner understands multi-line, type-only and re-export statements (self-check)', () => {
    const src = [
      `import type { A } from './a.js';`,
      `import {\n  B,\n  C,\n} from '../b.js';`,
      `export { D } from './d.js';`,
      `export * from './e.js';`,
      `import './f.js';`,
      `import * as fs from 'node:fs';`,
      `// import { Z } from './commented.js';`,
    ].join('\n');
    assert.deepEqual(relativeImports(src).sort(), ['../b.js', './a.js', './d.js', './e.js', './f.js']);
  });

  it('every kernel module and every forbidden module is a real file', () => {
    assert.ok(KERNEL_MODULES.length >= 6);
    for (const f of KERNEL_MODULES) assert.ok(fs.existsSync(path.join(ROOT, f)), `kernel module ${f} must exist`);
    for (const f of KERNEL_FORBIDDEN_IMPORTS) assert.ok(fs.existsSync(path.join(ROOT, f)), `forbidden module ${f} must exist (typo guard)`);
    for (const f of ['src/wall.ts', 'src/commands/lock.ts', 'src/commands/gaps.ts', 'src/commands/gate.ts', 'src/commands/qa.ts', 'src/commands/audit.ts']) {
      assert.ok(KERNEL_MODULES.includes(f), `${f} is part of the kernel`);
    }
    for (const f of KERNEL_FORBIDDEN_IMPORTS) assert.ok(!KERNEL_MODULES.includes(f), `${f} cannot be both kernel and add-on`);
  });

  it('lists the add-ons that must stay out of the kernel', () => {
    for (const f of ['src/map.ts', 'src/commands/run.ts', 'src/commands/flow.ts', 'src/slots.ts', 'src/split.ts', 'src/tier.ts', 'src/orchestrator/worktree.ts']) {
      assert.ok(KERNEL_FORBIDDEN_IMPORTS.includes(f), `${f} must be forbidden`);
    }
    assert.ok(!KERNEL_FORBIDDEN_IMPORTS.includes('src/state.ts'), 'src/state.ts is allowed');
  });

  it('src/wall.ts re-exports the five kernel commands as functions', () => {
    for (const name of ['runLock', 'findGaps', 'runGaps', 'runGate', 'runGateAsync', 'runQa', 'runAudit']) {
      assert.equal(typeof (wall as Record<string, unknown>)[name], 'function', `wall.${name}`);
    }
    assert.equal(wall.runLock, runLock);
    assert.equal(wall.findGaps, findGaps);
    assert.equal(wall.runQa, runQa);
  });

  for (const mod of KERNEL_MODULES) {
    it(`${mod} reaches no forbidden module through its imports`, () => {
      const reached = reachable(mod);
      const bad = KERNEL_FORBIDDEN_IMPORTS.filter((f) => reached.has(f));
      assert.deepEqual(
        bad.map((f) => `${f} via ${reached.get(f)!.join(' -> ')}`),
        [],
        `${mod} must not import add-ons`
      );
    });
  }
});

// ---------------------------------------------------------------- (2) standalone wall

const REQ = 'Add returns the sum of two numbers.\nNegative inputs are rejected with a RangeError.\n';
const ADD_TEST = [
  `import test from 'node:test';`,
  `import assert from 'node:assert/strict';`,
  `import { add } from '../src/add.mjs';`,
  `test('add basic', () => { const m = 'MARK_ADD_TEST'; assert.equal(add(2, 3), 5); });`,
  ``,
].join('\n');
const ZED_TEST = [
  `import test from 'node:test';`,
  `import assert from 'node:assert/strict';`,
  `import { add } from '../src/add.mjs';`,
  `test('add zero', () => { const m = 'MARK_ZED_TEST'; assert.equal(add(0, 0), 0); assert.equal(add(1, 1), 2); });`,
  ``,
].join('\n');
const STUB = 'export function add(a, b) { return 0; }\n';
const IMPL = 'export function add(a, b) { return a + b; }\n';
const PKG = '{ "name": "mini", "version": "1.0.0", "description": "PKG_MARKER_JSON" }\n';
const CASE_OK = "import { add } from '../../src/add.mjs';\nprocess.exit(add(2, 3) === 5 ? 0 : 1);\n";
const CASE_BAD = "console.log('STANDALONE_BOOM');\nprocess.exit(1);\n";
const QA_CASE = { name: 'add-case', rule: 'add sums', node: 'add', command: 'node .bastion/qa-cases/add.mjs' };
const BAD_CASE = { name: 'bad-case', rule: 'always broken', node: 'add', command: 'node .bastion/qa-cases/bad.mjs' };
const PASS = { verdict: 'pass', findings: [] as unknown[] };

const FILES_FOR_NODE = (extra: Record<string, string> = {}): Record<string, string> => ({
  'src/add.mjs': STUB,
  'tests/add.test.mjs': ADD_TEST,
  'tests/a-zed.test.mjs': ZED_TEST,
  'package.json': PKG,
  '.bastion/requirement.md': REQ,
  ...extra,
});

/** A repo with only init + stubs + red tests + requirement.md + a lock: no map, no plan, no run-state. */
function standaloneRepo(
  fixtures: Parameters<typeof createRoleRepo>[0]['fixtures'],
  extra: Record<string, string> = {}
): string {
  const repo = createRoleRepo({ fixtures, files: FILES_FOR_NODE(extra) });
  assert.equal(runLock({ cwd: repo }), 0, 'fixture lock must succeed');
  git(['add', '.'], repo);
  git(['commit', '-m', 'chore: lock'], repo);
  assert.equal(fs.existsSync(path.join(repo, '.bastion', 'map.json')), false);
  assert.equal(fs.existsSync(path.join(repo, '.bastion', 'plan.json')), false);
  assert.equal(fs.existsSync(path.join(repo, '.bastion', 'run-state.json')), false);
  return repo;
}

/** Implement on a branch and return to main (the main checkout keeps the stub). */
function commitImpl(repo: string, branch = 'feature'): void {
  git(['checkout', '-b', branch], repo);
  writeRepoFile(repo, 'src/add.mjs', IMPL);
  git(['add', '.'], repo);
  git(['commit', '-m', 'feat: implement add'], repo);
  git(['checkout', 'main'], repo);
}

const criticCalls = (repo: string) => readRoleCalls(repo).filter((c) => c.role === 'critic');
const qaCalls = (repo: string) => readRoleCalls(repo).filter((c) => c.role === 'qa');
const runStatePath = (repo: string) => path.join(repo, '.bastion', 'run-state.json');
const worktreeGone = (repo: string) => {
  assert.equal(fs.existsSync(path.join(repo, '.bastion', 'worktrees', 'qa')), false, 'QA worktree directory removed');
  assert.ok(!git(['worktree', 'list'], repo).replace(/\\/g, '/').includes('worktrees/qa'), 'QA worktree unregistered');
};
const qaFx = (qa: unknown, files: Record<string, string> = { '.bastion/qa-cases/add.mjs': CASE_OK }) => ({
  critic: { output: { gaps: [] } },
  qa: { output: qa, files },
});

describe('v1.1 wall: standalone gaps (lock only)', () => {
  it('works from the lock: test files in lock order, no package.json, no map, critic called once', async () => {
    const repo = standaloneRepo({ critic: { output: { gaps: [] } } });
    const r = await findGaps(repo);
    assert.equal(r.ok, true, r.error);
    const calls = criticCalls(repo);
    assert.equal(calls.length, 1);
    const p = calls[0].prompt;
    assert.ok(p.includes(REQ), 'requirement verbatim');
    assert.ok(p.includes(ADD_TEST) && p.includes(ZED_TEST), 'every locked test file verbatim');
    assert.ok(p.includes('### tests/add.test.mjs') && p.includes('### tests/a-zed.test.mjs'));
    assert.ok(!p.includes('package.json') && !p.includes('PKG_MARKER_JSON'), 'extraLockedPaths are not test files');
    assert.ok(p.indexOf('### tests/a-zed.test.mjs') < p.indexOf('### tests/add.test.mjs'), 'lock order (sorted paths)');
  });

  it('leaves out locked paths that do not match lockedGlobs, whatever their name', async () => {
    // tsconfig.json is an extraLockedPaths entry, a fixtures/ file too: both are locked, neither is a test file.
    const repo = standaloneRepo(
      { critic: { output: { gaps: [] } } },
      { 'tsconfig.json': '{ "note": "TSCONFIG_MARKER" }\n', 'data/fixtures/seed.json': '{ "note": "FIXTURE_MARKER" }\n' }
    );
    const lock = readJson<{ lockedFiles: Array<{ path: string }> }>(path.join(repo, '.bastion', 'lock.json'));
    const locked = lock.lockedFiles.map((f) => f.path);
    assert.ok(locked.includes('package.json') && locked.includes('tsconfig.json') && locked.includes('data/fixtures/seed.json'));
    const r = await findGaps(repo);
    assert.equal(r.ok, true, r.error);
    const p = criticCalls(repo)[0].prompt;
    for (const m of ['PKG_MARKER_JSON', 'TSCONFIG_MARKER', 'FIXTURE_MARKER']) assert.ok(!p.includes(m), m);
    assert.ok(p.includes('MARK_ADD_TEST') && p.includes('MARK_ZED_TEST'));
  });

  it('follows a custom config.lockedGlobs instead of a hard-coded test pattern', async () => {
    const repo = createRoleRepo({
      fixtures: { critic: { output: { gaps: [] } } },
      configPatch: { lockedGlobs: ['specs/**'], extraLockedPaths: [] },
      testCommand: 'node --test specs/*.test.mjs',
      files: {
        'src/add.mjs': STUB,
        'specs/add.test.mjs': ADD_TEST.replace('../src/add.mjs', '../src/add.mjs').replace('MARK_ADD_TEST', 'MARK_SPEC_ADD'),
        'tests/ignored.test.mjs': '// MARK_NOT_LOCKED\n',
        '.bastion/requirement.md': REQ,
      },
    });
    assert.equal(runLock({ cwd: repo }), 0);
    git(['add', '.'], repo);
    git(['commit', '-m', 'chore: lock'], repo);
    const r = await findGaps(repo);
    assert.equal(r.ok, true, r.error);
    const p = criticCalls(repo)[0].prompt;
    assert.ok(p.includes('MARK_SPEC_ADD') && p.includes('### specs/add.test.mjs'));
    assert.ok(!p.includes('MARK_NOT_LOCKED'), 'an unlocked test file is not shown');
  });

  it('never reads map.json: a map pointing at an unlocked test file does not change the prompt', async () => {
    const repo = standaloneRepo({ critic: { output: { gaps: [] } } });
    writeRepoFile(repo, 'tests/extra.test.mjs', '// MARK_ONLY_IN_MAP\n');
    writeRepoFile(
      repo,
      '.bastion/map.json',
      JSON.stringify({ version: 1, requirement: 'x', interfaces: 'y', nodes: [{ id: 'z', title: 'Z', summary: 's', files: ['src/z.mjs'], interface: 'i', acceptance: ['a'], testFile: 'tests/extra.test.mjs', testCommand: 'true' }] })
    );
    const r = await findGaps(repo);
    assert.equal(r.ok, true, r.error);
    assert.ok(!criticCalls(repo)[0].prompt.includes('MARK_ONLY_IN_MAP'));
    writeRepoFile(repo, '.bastion/map.json', '{ this is not json');
    assert.equal((await findGaps(repo)).ok, true, 'a broken map.json is irrelevant');
  });

  it('a locked test file that was deleted from disk is skipped; all gone -> !ok', async () => {
    const repo = standaloneRepo({ critic: { output: { gaps: [] } } });
    fs.rmSync(path.join(repo, 'tests', 'add.test.mjs'));
    const r = await findGaps(repo);
    assert.equal(r.ok, true, r.error);
    const p = criticCalls(repo)[0].prompt;
    assert.ok(p.includes('MARK_ZED_TEST') && !p.includes('MARK_ADD_TEST'));
    fs.rmSync(path.join(repo, 'tests', 'a-zed.test.mjs'));
    const before = criticCalls(repo).length;
    assert.equal((await findGaps(repo)).ok, false);
    assert.equal(criticCalls(repo).length, before, 'critic not called without a test file');
  });

  it('no lock.json -> !ok, critic never called, the error says to run bastion lock first', async () => {
    const repo = createRoleRepo({ fixtures: { critic: { output: { gaps: [] } } }, files: FILES_FOR_NODE() });
    const r = await findGaps(repo);
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /lock/i);
    assert.equal(criticCalls(repo).length, 0);
    // even with a map that lists a perfectly good test file
    writeRepoFile(repo, '.bastion/map.json', JSON.stringify({ version: 1, requirement: 'x', interfaces: 'y', nodes: [{ id: 'n', title: 'N', summary: 's', files: ['src/add.mjs'], interface: 'i', acceptance: ['a'], testFile: 'tests/add.test.mjs', testCommand: 'true' }] }));
    assert.equal((await findGaps(repo)).ok, false, 'the map is not a fallback');
    assert.equal(criticCalls(repo).length, 0);
  });

  it('explicit testFiles still win over the lock (and need no lock)', async () => {
    const repo = createRoleRepo({ fixtures: { critic: { output: { gaps: [] } } }, files: FILES_FOR_NODE() });
    const r = await findGaps(repo, { testFiles: ['tests/add.test.mjs'] });
    assert.equal(r.ok, true, r.error);
    const p = criticCalls(repo)[0].prompt;
    assert.ok(p.includes('MARK_ADD_TEST') && !p.includes('MARK_ZED_TEST'));
  });

  it('probe mode takes its cases from the locked test files too', async () => {
    const repo = standaloneRepo({
      critic: { byLabel: { 'gaps-probe': { output: { gaps: [{ rule: 'sum rule', quote: 'Add returns the sum of two numbers.' }] } }, 'gaps-probe-judge': { output: { detected: true } } } },
    });
    const r = await findGaps(repo, { probe: true });
    assert.equal(r.ok, true, r.error);
    assert.ok(r.probe && r.probe.file.startsWith('tests/'), JSON.stringify(r.probe));
    assert.equal(r.probe?.detected, true);
  });
});

describe('v1.1 wall: standalone qa (no run-state, no acceptance.md)', () => {
  it('passes against the ref branch with one passing case; the prompt has requirement and changed files, no acceptance section', async () => {
    const repo = standaloneRepo(qaFx({ ...PASS, cases: [QA_CASE] }));
    commitImpl(repo, 'feature');
    assert.equal(fs.existsSync(path.join(repo, '.bastion', 'acceptance.md')), false);
    const { result, out, err } = await captureConsole(() => runQa({ cwd: repo, ref: 'feature' }));
    assert.equal(result, 0, err);
    assert.ok(out.includes('[bastion] qa: pass (1 case(s) run).'), out);
    const calls = qaCalls(repo);
    assert.equal(calls.length, 1);
    const p = calls[0].prompt;
    assert.ok(p.includes('## Original requirement (source of truth)') && p.includes(REQ));
    assert.ok(!p.includes('## Acceptance (acceptance.md)'), 'no acceptance section without acceptance.md');
    const changed = p.slice(p.indexOf('## Changed files'));
    assert.ok(p.includes('## Changed files'));
    assert.ok(changed.includes('src/add.mjs') && /\|\s*\d+/.test(changed), 'git diff --stat main...feature');
    assert.ok(!changed.includes('(unavailable)'));
    assert.ok(!p.includes('diff --git'));
    assert.equal(fs.existsSync(runStatePath(repo)), false, 'passing standalone qa creates no run-state');
    assert.ok(fs.existsSync(path.join(repo, '.bastion', 'qa-run.json')));
    assert.ok(fs.existsSync(path.join(repo, '.bastion', 'qa.json')));
    worktreeGone(repo);
    assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], repo), 'main', 'main checkout is left alone');
    assert.ok(fs.readFileSync(path.join(repo, 'src', 'add.mjs'), 'utf8').includes('return 0'), 'main checkout still has the stub');
  });

  it('really checks out the ref: a case that needs the implementation fails against the stub branch', async () => {
    const repo = standaloneRepo(qaFx({ ...PASS, cases: [QA_CASE] }));
    commitImpl(repo, 'feature');
    git(['branch', 'stubbed', 'main'], repo);
    const { result } = await captureConsole(() => runQa({ cwd: repo, ref: 'stubbed' }));
    assert.equal(result, 1, 'the target is the ref, not the main checkout and not an implicit branch');
    worktreeGone(repo);
  });

  it('without ref the target is HEAD', async () => {
    const repo = standaloneRepo(qaFx({ ...PASS, cases: [QA_CASE] }));
    git(['checkout', '-b', 'feature'], repo);
    writeRepoFile(repo, 'src/add.mjs', IMPL);
    git(['add', '.'], repo);
    git(['commit', '-m', 'feat: implement add'], repo);
    const { result, err } = await captureConsole(() => runQa({ cwd: repo }));
    assert.equal(result, 0, err);
    assert.equal(fs.existsSync(runStatePath(repo)), false);
    worktreeGone(repo);
  });

  it('a failing case returns 1, appends feedback/<node>.md, prints the standalone hint and creates no run-state', async () => {
    const repo = standaloneRepo(qaFx({ ...PASS, cases: [QA_CASE, BAD_CASE] }, { '.bastion/qa-cases/add.mjs': CASE_OK, '.bastion/qa-cases/bad.mjs': CASE_BAD }));
    commitImpl(repo, 'feature');
    const { result, out, err } = await captureConsole(() => runQa({ cwd: repo, ref: 'feature' }));
    assert.equal(result, 1);
    assert.ok(!out.includes('qa: pass'));
    const lines = err.split('\n').map((l) => l.trim()).filter(Boolean);
    assert.equal(lines[lines.length - 1], '[bastion] qa: fix the findings, then run bastion qa again.', err);
    assert.ok(!/run --resume/.test(out + err), 'no run --resume hint without a run');
    const fb = path.join(repo, '.bastion', 'feedback', 'add.md');
    assert.ok(fs.existsSync(fb), 'feedback/<node>.md written');
    const text = fs.readFileSync(fb, 'utf8');
    assert.ok(text.includes('black-box case "bad-case" failed (always broken)') && text.includes('STANDALONE_BOOM'), text);
    assert.equal(fs.existsSync(runStatePath(repo)), false, 'run-state.json is not created');
    worktreeGone(repo);
    // a second run appends instead of overwriting
    await captureConsole(() => runQa({ cwd: repo, ref: 'feature' }));
    assert.equal(fs.readFileSync(fb, 'utf8').split('black-box case "bad-case"').length - 1, 2, 'feedback is appended');
    assert.equal(fs.existsSync(runStatePath(repo)), false);
  });

  it('a code finding from the role (pass verdict) also lands in feedback and ends with the standalone hint', async () => {
    const repo = standaloneRepo(qaFx({ ...PASS, findings: [{ node: 'add', kind: 'code', issue: 'ROLE_FINDING_ADD' }], cases: [QA_CASE] }));
    commitImpl(repo, 'feature');
    const { result, err } = await captureConsole(() => runQa({ cwd: repo, ref: 'feature' }));
    assert.equal(result, 1);
    assert.ok(fs.readFileSync(path.join(repo, '.bastion', 'feedback', 'add.md'), 'utf8').includes('ROLE_FINDING_ADD'));
    assert.ok(err.trim().endsWith('[bastion] qa: fix the findings, then run bastion qa again.'), err);
    assert.equal(fs.existsSync(runStatePath(repo)), false);
  });

  it('a test_defect finding in standalone mode goes to qa-disputes.md, still without a run-state', async () => {
    const repo = standaloneRepo(qaFx({ ...PASS, findings: [{ node: 'add', kind: 'test_defect', issue: 'DEFECT_ADD' }], cases: [QA_CASE] }));
    commitImpl(repo, 'feature');
    const { result } = await captureConsole(() => runQa({ cwd: repo, ref: 'feature' }));
    assert.equal(result, 1);
    assert.ok(fs.readFileSync(path.join(repo, '.bastion', 'qa-disputes.md'), 'utf8').includes('DEFECT_ADD'));
    assert.equal(fs.existsSync(runStatePath(repo)), false);
  });

  it('a base branch that does not exist gives "(unavailable)" in Changed files and is not an error', async () => {
    const repo = standaloneRepo(qaFx({ ...PASS, cases: [QA_CASE] }));
    commitImpl(repo, 'feature');
    const cfgPath = path.join(repo, '.bastion', 'config.json');
    const cfg = readJson<Record<string, unknown>>(cfgPath);
    fs.writeFileSync(cfgPath, JSON.stringify({ ...cfg, baseBranch: 'no-such-base' }, null, 2));
    const { result, err } = await captureConsole(() => runQa({ cwd: repo, ref: 'feature' }));
    assert.equal(result, 0, err);
    const p = qaCalls(repo)[0].prompt;
    const changed = p.slice(p.indexOf('## Changed files'));
    assert.ok(p.includes('## Changed files'));
    assert.ok(changed.includes('(unavailable)'), changed);
    assert.ok(!/git diff failed/.test(err));
    worktreeGone(repo);
  });

  it('a ref that does not exist is an error (nothing to check out), role not called, no leftover worktree', async () => {
    const repo = standaloneRepo(qaFx({ ...PASS, cases: [QA_CASE] }));
    const { result } = await captureConsole(() => runQa({ cwd: repo, ref: 'no-such-branch' }));
    assert.equal(result, 1);
    assert.equal(qaCalls(repo).length, 0);
    assert.equal(fs.existsSync(runStatePath(repo)), false);
    worktreeGone(repo);
  });

  it('a report without a case is still refused in standalone mode', async () => {
    const repo = standaloneRepo(qaFx({ ...PASS, cases: [] }));
    commitImpl(repo, 'feature');
    const { result, err } = await captureConsole(() => runQa({ cwd: repo, ref: 'feature' }));
    assert.equal(result, 1);
    assert.equal(qaCalls(repo).length, 1);
    assert.ok(err.includes('[bastion] qa: the qa role ran no black-box case.'), err);
    assert.equal(fs.existsSync(runStatePath(repo)), false);
  });

  it('an acceptance.md that exists is still shown in standalone mode', async () => {
    const repo = standaloneRepo(qaFx({ ...PASS, cases: [QA_CASE] }), { '.bastion/acceptance.md': '# Acceptance\n\nACCEPT_MARK_STANDALONE\n' });
    commitImpl(repo, 'feature');
    const { result, err } = await captureConsole(() => runQa({ cwd: repo, ref: 'feature' }));
    assert.equal(result, 0, err);
    const p = qaCalls(repo)[0].prompt;
    assert.ok(p.includes('## Acceptance (acceptance.md)') && p.includes('ACCEPT_MARK_STANDALONE'));
  });
});

describe('v1.1 wall: with a run-state the old behaviour holds', () => {
  /** Standalone repo plus a hand-written run-state whose integration branch carries the implementation. */
  function repoWithRunState(qa: unknown, files?: Record<string, string>): string {
    const repo = standaloneRepo(qaFx(qa, files));
    commitImpl(repo, 'bastion/integration');
    writeRepoFile(repo, '.bastion/acceptance.md', '# Acceptance\n\nACCEPT_MARK_RUN\n');
    writeRepoFile(repo, '.bastion/run-state.json', JSON.stringify({ integrationBranch: 'bastion/integration', baseRef: 'main', completedNodes: ['add', 'other'] }, null, 2));
    return repo;
  }
  const completed = (repo: string) => readJson<{ completedNodes: string[] }>(runStatePath(repo)).completedNodes;

  it('no ref: checks the integration branch (not HEAD), shows acceptance.md and leaves the run-state alone on pass', async () => {
    const repo = repoWithRunState({ ...PASS, cases: [QA_CASE] });
    assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], repo), 'main');
    const { result, err } = await captureConsole(() => runQa({ cwd: repo }));
    assert.equal(result, 0, err + ' (the case only passes in the integration checkout)');
    const p = qaCalls(repo)[0].prompt;
    assert.ok(p.includes('## Acceptance (acceptance.md)') && p.includes('ACCEPT_MARK_RUN'));
    assert.ok(p.slice(p.indexOf('## Changed files')).includes('src/add.mjs'));
    assert.deepEqual(completed(repo), ['add', 'other']);
    worktreeGone(repo);
  });

  it('no ref, failing case: reopens only that node and points at run --resume', async () => {
    const repo = repoWithRunState({ ...PASS, cases: [QA_CASE, BAD_CASE] }, { '.bastion/qa-cases/add.mjs': CASE_OK, '.bastion/qa-cases/bad.mjs': CASE_BAD });
    const { result, out, err } = await captureConsole(() => runQa({ cwd: repo }));
    assert.equal(result, 1);
    assert.deepEqual(completed(repo), ['other'], 'node "add" reopened');
    assert.ok(fs.readFileSync(path.join(repo, '.bastion', 'feedback', 'add.md'), 'utf8').includes('bad-case'));
    assert.match(out + err, /run --resume/);
    assert.ok(!err.includes('fix the findings, then run bastion qa again.'), 'the standalone hint is only for standalone mode');
  });

  it('an explicit ref makes it standalone even when a run-state exists: nothing is reopened, run-state untouched', async () => {
    const repo = repoWithRunState({ ...PASS, cases: [QA_CASE, BAD_CASE] }, { '.bastion/qa-cases/add.mjs': CASE_OK, '.bastion/qa-cases/bad.mjs': CASE_BAD });
    const before = fs.readFileSync(runStatePath(repo), 'utf8');
    const { result, err } = await captureConsole(() => runQa({ cwd: repo, ref: 'bastion/integration' }));
    assert.equal(result, 1);
    assert.equal(fs.readFileSync(runStatePath(repo), 'utf8'), before, 'run-state not rewritten');
    assert.ok(fs.existsSync(path.join(repo, '.bastion', 'feedback', 'add.md')), 'code findings still write feedback');
    assert.ok(err.trim().endsWith('[bastion] qa: fix the findings, then run bastion qa again.'), err);
  });
});
