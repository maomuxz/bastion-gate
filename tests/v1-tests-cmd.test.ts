// v1.0 P4 - `bastion tests [--lock]`: one tester call per map node, test files committed, optional lock.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { runTests } from '../src/commands/tests.js';
import { captureConsole, cleanupTempRepos, git, readJson } from './v04-helpers.js';
import { createRoleRepo, readRoleCalls, sampleMap, SAMPLE_FILES, setFixtures } from './v1-helpers.js';
import type { RoleFixtures } from './v1-helpers.js';

afterEach(cleanupTempRepos);

const MARK = 'SHARED-INTERFACES-MARKER-7731';
const T = SAMPLE_FILES.tests;

function baseFiles(extra: Record<string, string> = {}): Record<string, string> {
  return {
    '.bastion/map.json': JSON.stringify(sampleMap(), null, 2),
    '.bastion/interfaces.md': `# Interfaces\n${MARK}\n`,
    ...SAMPLE_FILES.stubs,
    ...extra,
  };
}

function perNode(files1: Record<string, string>, files2: Record<string, string>): RoleFixtures {
  // Labels are not specified exactly; give the base the union and byLabel for both likely labels.
  return {
    tester: {
      files: { ...files1, ...files2 },
      byLabel: {
        'tests-n1': { files: files1 },
        'tests-n2': { files: files2 },
      },
    },
  };
}

const GOOD: RoleFixtures = perNode({ 'tests/add.test.mjs': T['tests/add.test.mjs'] }, { 'tests/mul.test.mjs': T['tests/mul.test.mjs'] });

const SLOW_TESTER = [
  `import * as fs from 'node:fs';`,
  `const label = process.env.BASTION_NODE_ID || '';`,
  `const log = process.env.BASTION_HOME + '/conc.jsonl';`,
  `fs.appendFileSync(log, JSON.stringify({ label, ev: 'start', t: Date.now() }) + '\\n');`,
  `await new Promise((r) => setTimeout(r, 900));`,
  `fs.mkdirSync('tests', { recursive: true });`,
  `const id = /n2/.test(label) ? 'mul' : 'add';`,
  `const src = fs.readFileSync(process.env.BASTION_HOME + '/fixture-' + id + '.txt', 'utf8');`,
  `fs.writeFileSync('tests/' + id + '.test.mjs', src);`,
  `fs.appendFileSync(log, JSON.stringify({ label, ev: 'end', t: Date.now() }) + '\\n');`,
].join('\n') + '\n';

function slowRepo(): string {
  return createRoleRepo({
    fixtures: {},
    files: baseFiles({
      'scripts/slow-tester.mjs': SLOW_TESTER,
      'fixture-add.txt': T['tests/add.test.mjs'],
      'fixture-mul.txt': T['tests/mul.test.mjs'],
    }),
    configPatch: { roles: { planner: 'x', blind: 'x', worker: 'x', qa: 'x', tester: 'node scripts/slow-tester.mjs' } },
  });
}

function intervals(repo: string): Array<{ s: number; e: number }> {
  const rows = fs.readFileSync(path.join(repo, 'conc.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l) as { label: string; ev: string; t: number });
  return [...new Set(rows.map((r) => r.label))].map((label) => ({
    s: rows.find((r) => r.label === label && r.ev === 'start')!.t,
    e: rows.find((r) => r.label === label && r.ev === 'end')!.t,
  }));
}

const overlaps = (a: { s: number; e: number }, b: { s: number; e: number }) => a.s < b.e && b.s < a.e;

describe('v1.0 bastion tests', () => {
  it('calls the tester once per node with interfaces.md, interface, acceptance and testFile', async () => {
    const repo = createRoleRepo({ fixtures: GOOD, files: baseFiles() });
    const { result } = await captureConsole(() => runTests({ cwd: repo }));
    assert.equal(result, 0);
    const calls = readRoleCalls(repo);
    assert.equal(calls.length, 2);
    assert.ok(calls.every((c) => c.role === 'tester'));
    const c1 = calls.find((c) => c.label.includes('n1'));
    const c2 = calls.find((c) => c.label.includes('n2'));
    assert.ok(c1 && c2, `labels: ${calls.map((c) => c.label).join(',')}`);
    for (const c of [c1, c2]) assert.ok(c.prompt.includes(MARK), 'prompt carries interfaces.md');
    assert.ok(c1.prompt.includes('export function add(a: number, b: number): number'));
    assert.ok(c1.prompt.includes('add(2, 3) is 5'));
    assert.ok(c1.prompt.includes('tests/add.test.mjs'));
    assert.ok(!c1.prompt.includes('tests/mul.test.mjs'), 'n1 prompt is about n1 only');
    assert.ok(c2.prompt.includes('export function mul(a: number, b: number): number'));
    assert.ok(c2.prompt.includes('mul(4, 5) is 20'));
    assert.ok(c2.prompt.includes('tests/mul.test.mjs'));
    assert.ok(!c2.prompt.includes('add(2, 3) is 5'), 'n2 prompt is about n2 only');
  });

  it('commits the test files as "test(bastion): acceptance tests" and does not lock without --lock', async () => {
    const repo = createRoleRepo({ fixtures: GOOD, files: baseFiles() });
    const { result } = await captureConsole(() => runTests({ cwd: repo }));
    assert.equal(result, 0);
    assert.equal(git(['log', '-1', '--format=%s'], repo).trim(), 'test(bastion): acceptance tests');
    const files = git(['show', '--name-only', '--format=', 'HEAD'], repo).split(/\r?\n/).filter(Boolean).sort();
    assert.deepEqual(files, ['tests/add.test.mjs', 'tests/mul.test.mjs']);
    assert.equal(git(['status', '--porcelain', '--', 'tests'], repo).trim(), '', 'test files are committed');
    assert.equal(fs.existsSync(path.join(repo, '.bastion', 'lock.json')), false);
  });

  it('returns 1 when the tester leaves a test file missing, and still ran every node', async () => {
    const repo = createRoleRepo({
      fixtures: perNode({ 'tests/add.test.mjs': T['tests/add.test.mjs'] }, {}),
      files: baseFiles(),
    });
    // base would hand n2 the union; make the base empty so n2 truly writes nothing
    setFixtures(repo, { tester: { byLabel: { 'tests-n1': { files: { 'tests/add.test.mjs': T['tests/add.test.mjs'] } } } } });
    const { result } = await captureConsole(() => runTests({ cwd: repo }));
    assert.equal(result, 1);
    assert.equal(readRoleCalls(repo).length, 2, 'every node is attempted');
    assert.equal(fs.existsSync(path.join(repo, '.bastion', 'lock.json')), false);
  });

  it('treats an empty test file as missing', async () => {
    const repo = createRoleRepo({
      fixtures: perNode({ 'tests/add.test.mjs': T['tests/add.test.mjs'] }, { 'tests/mul.test.mjs': '' }),
      files: baseFiles(),
    });
    const { result } = await captureConsole(() => runTests({ cwd: repo }));
    assert.equal(result, 1);
    assert.equal(readRoleCalls(repo).length, 2, 'every node is attempted');
  });

  it('returns 1 when the tester process exits non-zero even if it wrote the file', async () => {
    const fx = perNode({ 'tests/add.test.mjs': T['tests/add.test.mjs'] }, { 'tests/mul.test.mjs': T['tests/mul.test.mjs'] });
    fx.tester!.exit = 3;
    fx.tester!.byLabel!['tests-n1']!.exit = 3;
    fx.tester!.byLabel!['tests-n2']!.exit = 3;
    const repo = createRoleRepo({ fixtures: fx, files: baseFiles() });
    const { result } = await captureConsole(() => runTests({ cwd: repo }));
    assert.equal(result, 1);
    assert.equal(readRoleCalls(repo).length, 2, 'every node is attempted');
  });

  it('--lock writes and commits .bastion/lock.json covering the test files', async () => {
    const repo = createRoleRepo({ fixtures: GOOD, files: baseFiles() });
    const { result } = await captureConsole(() => runTests({ cwd: repo, lock: true }));
    assert.equal(result, 0);
    const lockPath = path.join(repo, '.bastion', 'lock.json');
    assert.ok(fs.existsSync(lockPath));
    const lock = readJson<{ lockedFiles: Array<{ path: string }>; amendments?: unknown[] }>(lockPath);
    const locked = lock.lockedFiles.map((f) => f.path);
    assert.ok(locked.includes('tests/add.test.mjs') && locked.includes('tests/mul.test.mjs'));
    assert.equal(lock.amendments, undefined, 'first lock is not an amendment');
    assert.equal(git(['ls-files', '.bastion/lock.json'], repo).trim(), '.bastion/lock.json');
    assert.equal(git(['status', '--porcelain', '--', '.bastion/lock.json', 'tests'], repo).trim(), '', 'lock + tests are committed');
    const tracked = git(['log', '--name-only', '--format=%s'], repo);
    assert.match(tracked, /test\(bastion\): acceptance tests/);
  });

  it('--lock returns the lock result: green tests are refused and no lock is committed', async () => {
    const repo = createRoleRepo({ fixtures: GOOD, files: baseFiles(SAMPLE_FILES.impl) });
    const { result } = await captureConsole(() => runTests({ cwd: repo, lock: true }));
    assert.equal(result, 1);
    assert.equal(readRoleCalls(repo).length, 2, 'testers ran before the lock was refused');
    assert.equal(fs.existsSync(path.join(repo, '.bastion', 'lock.json')), false);
  });

  it('--lock on an existing lock amends it with reason "bastion tests"', async () => {
    const repo = createRoleRepo({ fixtures: GOOD, files: baseFiles() });
    assert.equal((await captureConsole(() => runTests({ cwd: repo, lock: true }))).result, 0);
    const stronger = `${T['tests/add.test.mjs']}test('add more', () => { assert.equal(add(10, 5), 15); });\n`;
    setFixtures(repo, perNode({ 'tests/add.test.mjs': stronger }, { 'tests/mul.test.mjs': T['tests/mul.test.mjs'] }));
    const { result } = await captureConsole(() => runTests({ cwd: repo, lock: true }));
    assert.equal(result, 0);
    const lock = readJson<{ amendments?: Array<{ reason: string }>; lockedFiles: Array<{ path: string }> }>(path.join(repo, '.bastion', 'lock.json'));
    assert.equal(lock.amendments?.length, 1);
    assert.equal(lock.amendments?.[0].reason, 'bastion tests');
    assert.equal(git(['status', '--porcelain', '--', '.bastion/lock.json', 'tests'], repo).trim(), '');
  });

  it('runs testers in parallel by default (concurrency 2)', async () => {
    const repo = slowRepo();
    const { result } = await captureConsole(() => runTests({ cwd: repo }));
    assert.equal(result, 0);
    const [a, b] = intervals(repo);
    assert.ok(overlaps(a, b), 'two nodes should run at once by default');
  });

  it('concurrency 1 runs testers strictly one after another', async () => {
    const repo = slowRepo();
    const { result } = await captureConsole(() => runTests({ cwd: repo, concurrency: 1 }));
    assert.equal(result, 0);
    const [a, b] = intervals(repo);
    assert.ok(!overlaps(a, b), 'nodes must not overlap with concurrency 1');
  });
});
