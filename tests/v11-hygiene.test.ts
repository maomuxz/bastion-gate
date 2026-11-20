// v1.1 hygiene - line-ending independent hashes, the test dependency scan, and commits that work without a git identity.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { isAuthorizedAmendment, runAudit } from '../src/commands/audit.js';
import { runFlow } from '../src/commands/flow.js';
import { runInit } from '../src/commands/init.js';
import { runLock } from '../src/commands/lock.js';
import { runReview } from '../src/commands/review.js';
import { runScaffold } from '../src/commands/scaffold.js';
import { runTests } from '../src/commands/tests.js';
import type { BastionPlan } from '../src/config.js';
import { mapToPlan } from '../src/map.js';
import { contentHash, hashMatches } from '../src/runner.js';
import { captureConsole, cleanupTempRepos, createTempGitRepo, git, readJson, writeRepoFile } from './v04-helpers.js';
import { createRoleRepo, sampleMap, SAMPLE_FILES } from './v1-helpers.js';
import type { RoleFixtures } from './v1-helpers.js';

afterEach(cleanupTempRepos);

const sha = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

describe('v1.1 contentHash / hashMatches', () => {
  it('contentHash is the sha256 of the buffer with every CRLF turned into LF', () => {
    assert.equal(contentHash(Buffer.from('a\r\nb\r\n')), sha('a\nb\n'));
    assert.equal(contentHash(Buffer.from('a\nb\n')), sha('a\nb\n'));
    assert.equal(contentHash(Buffer.from('a\r\n\r\nb')), sha('a\n\nb'));
    assert.equal(contentHash(Buffer.from('')), sha(''));
    assert.match(contentHash(Buffer.from('x')), /^[0-9a-f]{64}$/);
  });

  it('contentHash leaves a lone CR alone and replaces CRLF only once ("\\r\\r\\n" -> "\\r\\n")', () => {
    assert.equal(contentHash(Buffer.from('a\rb\r')), sha('a\rb\r'));
    assert.equal(contentHash(Buffer.from('a\r\r\nb')), sha('a\r\nb'));
  });

  it('contentHash hashes a buffer with a NUL byte as is, even if it contains CRLF', () => {
    const bin = Buffer.from([0x89, 0x50, 0x00, 0x0d, 0x0a, 0x1a, 0x0d, 0x0a, 0x00]);
    assert.equal(contentHash(bin), sha(bin));
    assert.notEqual(contentHash(bin), sha(Buffer.from(bin.toString('latin1').replace(/\r\n/g, '\n'), 'latin1')));
  });

  it('hashMatches accepts the normalised hash, the raw hash and the hash of the CRLF-expanded buffer', () => {
    const lf = Buffer.from('one\ntwo\nthree\n');
    assert.equal(hashMatches(lf, sha('one\ntwo\nthree\n')), true, 'raw / normalised (LF buffer)');
    assert.equal(hashMatches(lf, sha('one\r\ntwo\r\nthree\r\n')), true, 'an LF blob against a lock written from the CRLF copy');

    const crlf = Buffer.from('one\r\ntwo\r\nthree\r\n');
    assert.equal(hashMatches(crlf, sha('one\r\ntwo\r\nthree\r\n')), true, 'raw');
    assert.equal(hashMatches(crlf, sha('one\ntwo\nthree\n')), true, 'normalised');
  });

  it('the CRLF expansion touches only LF that has no CR before it', () => {
    const mixed = Buffer.from('a\nb\r\nc\n');
    assert.equal(hashMatches(mixed, sha('a\r\nb\r\nc\r\n')), true);
    // a CR is never doubled: the expanded form of an already-CRLF line is itself
    assert.equal(hashMatches(mixed, sha('a\r\r\nb\r\r\nc\r\r\n')), false);
  });

  it('hashMatches is case-insensitive on the hex string', () => {
    const buf = Buffer.from('x\r\ny\r\n');
    assert.equal(hashMatches(buf, sha('x\ny\n').toUpperCase()), true);
    assert.equal(hashMatches(buf, sha(buf).toUpperCase()), true);
  });

  it('hashMatches rejects other content, an empty or malformed string and a lone-CR variant', () => {
    const buf = Buffer.from('x\ny\n');
    assert.equal(hashMatches(buf, sha('x\ny\nz\n')), false);
    assert.equal(hashMatches(buf, sha('x\ry\r')), false);
    assert.equal(hashMatches(buf, ''), false);
    assert.equal(hashMatches(buf, 'not-a-hash'), false);
    assert.equal(hashMatches(Buffer.from([0, 1, 2]), sha(Buffer.from([0, 1, 3]))), false);
  });

  it('hashMatches on a binary buffer accepts only its raw hash', () => {
    const bin = Buffer.from([0x00, 0x0d, 0x0a, 0x01]);
    assert.equal(hashMatches(bin, sha(bin)), true);
    assert.equal(hashMatches(bin, sha(Buffer.from([0x00, 0x0a, 0x01]))), false);
  });
});

const TEST_REL = 'tests/a.test.mjs';
const LOCK_REL = '.bastion/lock.json';

function testSource(expected: number): string {
  return `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { a } from '../src/a.mjs';\ntest('a is ${expected}', () => { assert.equal(a(), ${expected}); });\n`;
}
const crlf = (s: string): string => s.replace(/\n/g, '\r\n');

function commitAll(repo: string, msg: string): void {
  git(['add', '-A'], repo);
  git(['commit', '-m', msg], repo);
}

/** A repo with a red test written with CRLF line endings on disk. `autocrlf` decides what git stores. */
function crlfRepo(autocrlf: 'true' | 'false'): string {
  const repo = createTempGitRepo();
  git(['config', 'core.autocrlf', autocrlf], repo);
  runInit({ cwd: repo, testCommand: 'node --test tests/*.test.mjs', baseBranch: 'main' });
  writeRepoFile(repo, 'src/a.mjs', 'export function a() { return 0; }\n');
  writeRepoFile(repo, TEST_REL, crlf(testSource(1)));
  commitAll(repo, 'chore: baseline');
  return repo;
}

function lockedHash(repo: string, rel: string): string | undefined {
  return readJson<{ lockedFiles: Array<{ path: string; sha256: string }> }>(path.join(repo, LOCK_REL)).lockedFiles.find((f) => f.path === rel)?.sha256;
}

describe('v1.1 lock hashes are line-ending independent', () => {
  it('runLock records the hash of the LF text for a test file that has CRLF on disk', async () => {
    const repo = crlfRepo('false');
    assert.ok(fs.readFileSync(path.join(repo, TEST_REL), 'utf8').includes('\r\n'), 'fixture: CRLF on disk');
    const { result } = await captureConsole(() => runLock({ cwd: repo }));
    assert.equal(result, 0);
    assert.equal(lockedHash(repo, TEST_REL), sha(testSource(1)));
    assert.notEqual(lockedHash(repo, TEST_REL), sha(crlf(testSource(1))));
  });

  it('runLock gives the same hash for the same test with LF endings', async () => {
    const repo = createTempGitRepo();
    git(['config', 'core.autocrlf', 'false'], repo);
    runInit({ cwd: repo, testCommand: 'node --test tests/*.test.mjs', baseBranch: 'main' });
    writeRepoFile(repo, 'src/a.mjs', 'export function a() { return 0; }\n');
    writeRepoFile(repo, TEST_REL, testSource(1));
    commitAll(repo, 'chore: baseline');
    assert.equal((await captureConsole(() => runLock({ cwd: repo }))).result, 0);
    assert.equal(lockedHash(repo, TEST_REL), sha(testSource(1)));
  });
});

/** Branch off main, amend the lock after changing the test (CRLF on disk), merge --no-ff back. Returns the merge sha. */
async function crlfAmendMerge(repo: string, afterAmend?: () => void): Promise<string> {
  assert.equal((await captureConsole(() => runLock({ cwd: repo }))).result, 0);
  commitAll(repo, 'chore: lock');
  git(['checkout', '-b', 'fix-test'], repo);
  writeRepoFile(repo, TEST_REL, crlf(testSource(2)));
  commitAll(repo, 'test: expect 2');
  const { result } = await captureConsole(() => runLock({ cwd: repo, amend: true, reason: 'test was wrong' }));
  assert.equal(result, 0, 'fixture: amend must succeed');
  commitAll(repo, 'chore: amend lock');
  afterAmend?.();
  git(['checkout', 'main'], repo);
  git(['merge', '--no-ff', 'fix-test', '-m', 'merge fix-test'], repo);
  return git(['rev-parse', 'HEAD'], repo);
}

describe('v1.1 audit with CRLF working copies', () => {
  it('reports an amendment whose lock was written from a CRLF working copy as authorised, exit 0', async () => {
    const repo = crlfRepo('true');
    const mergeSha = await crlfAmendMerge(repo);
    // git stores LF for this file, the lock was written from the CRLF copy
    assert.equal(git(['show', `${mergeSha}:${TEST_REL}`], repo).includes('\r'), false, 'fixture: LF blob');
    assert.equal(isAuthorizedAmendment(repo, mergeSha, [TEST_REL, LOCK_REL]), true);
    const { result, out, err } = await captureConsole(() => runAudit({ cwd: repo }));
    assert.equal(result, 0, err);
    assert.match(out, /authorised lock amendment/);
    assert.doesNotMatch(err, /\[FAIL\]/);
  });

  it('still accepts a lock written by <= 1.0, which hashed the CRLF working copy raw', async () => {
    const repo = crlfRepo('true');
    const mergeSha = await crlfAmendMerge(repo, () => {
      const lockPath = path.join(repo, LOCK_REL);
      const lock = readJson<{ lockedFiles: Array<{ path: string; sha256: string }> }>(lockPath);
      for (const f of lock.lockedFiles) if (f.path === TEST_REL) f.sha256 = sha(crlf(testSource(2)));
      fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
      git(['add', '-A'], repo);
      git(['commit', '--allow-empty', '-m', 'chore: legacy hash'], repo);
    });
    assert.equal(isAuthorizedAmendment(repo, mergeSha, [TEST_REL]), true);
    const { result, err } = await captureConsole(() => runAudit({ cwd: repo }));
    assert.equal(result, 0, err);
  });

  it('still fails when the merged test differs from what the CRLF lock recorded', async () => {
    const repo = crlfRepo('true');
    const mergeSha = await crlfAmendMerge(repo, () => {
      writeRepoFile(repo, TEST_REL, crlf(testSource(77)));
      commitAll(repo, 'test: swap after amend');
    });
    assert.equal(isAuthorizedAmendment(repo, mergeSha, [TEST_REL]), false);
    const { result, err } = await captureConsole(() => runAudit({ cwd: repo }));
    assert.equal(result, 1);
    assert.ok(err.includes(TEST_REL));
  });
});

// ---------------------------------------------------------------- dependency scan

const T = SAMPLE_FILES.tests;
const REQ_NOTE = 'tests/mul.test.mjs';
const MUL_TEST_IMPORTING_ADD = `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/add.mjs';\nimport { mul } from '../src/mul.mjs';\ntest('mul', () => { assert.equal(add(1, 1) + mul(4, 5), 22); });\n`;
const ADD_TEST_IMPORTING_MUL = `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/add.mjs';\nimport { mul } from '../src/mul.mjs';\ntest('add', () => { assert.equal(add(2, 3) + mul(0, 0), 5); });\n`;

function testerFixtures(add: string, mul: string): RoleFixtures {
  return {
    tester: {
      files: { 'tests/add.test.mjs': add, [REQ_NOTE]: mul },
      byLabel: {
        'tests-n1': { files: { 'tests/add.test.mjs': add } },
        'tests-n2': { files: { [REQ_NOTE]: mul } },
      },
    },
  };
}

function scanRepo(opts: { map?: ReturnType<typeof sampleMap>; plan?: BastionPlan | null; add?: string; mul?: string }): { repo: string; mapBytes: Buffer } {
  const map = opts.map ?? sampleMap();
  const files: Record<string, string> = {
    '.bastion/map.json': JSON.stringify(map, null, 2),
    '.bastion/interfaces.md': '# Interfaces\n',
    ...SAMPLE_FILES.stubs,
  };
  if (opts.plan !== null) files['.bastion/plan.json'] = JSON.stringify(opts.plan ?? mapToPlan(map), null, 2) + '\n';
  const repo = createRoleRepo({ fixtures: testerFixtures(opts.add ?? T['tests/add.test.mjs'], opts.mul ?? T['tests/mul.test.mjs']), files });
  return { repo, mapBytes: fs.readFileSync(path.join(repo, '.bastion', 'map.json')) };
}

function readPlan(repo: string): BastionPlan {
  return readJson<BastionPlan>(path.join(repo, '.bastion', 'plan.json'));
}

function mapWithoutN2Dep(): ReturnType<typeof sampleMap> {
  const map = sampleMap();
  delete map.nodes[1].dependsOn;
  return map;
}

const LAST_PLAN_COMMIT = ['log', '-n', '1', '--format=%s', '--', '.bastion/plan.json'];

describe('v1.1 runTests dependency scan', () => {
  it('adds the dependency the planner forgot, prints it, commits plan.json with the tests and leaves map.json alone', async () => {
    const { repo, mapBytes } = scanRepo({ map: mapWithoutN2Dep(), mul: MUL_TEST_IMPORTING_ADD });
    assert.deepEqual(readPlan(repo).nodes[1].dependsOn, [], 'fixture: n2 has no dependency yet');
    const { result, out } = await captureConsole(() => runTests({ cwd: repo }));
    assert.equal(result, 0);

    const plan = readPlan(repo);
    assert.deepEqual(plan.nodes.find((n) => n.id === 'n2')?.dependsOn, ['n1']);
    assert.deepEqual(plan.nodes.find((n) => n.id === 'n1')?.dependsOn ?? [], []);
    assert.ok(out.split(/\r?\n/).includes('[bastion] tests: added dependency n2 -> n1 (its test imports src/add.mjs).'), out);

    assert.equal(git(LAST_PLAN_COMMIT, repo), 'test(bastion): acceptance tests');
    assert.equal(git(['log', '-1', '--format=%s'], repo), 'test(bastion): acceptance tests');
    const files = git(['show', '--name-only', '--format=', 'HEAD'], repo).split(/\r?\n/).filter(Boolean).sort();
    assert.deepEqual(files, ['.bastion/plan.json', 'tests/add.test.mjs', 'tests/mul.test.mjs']);
    assert.equal(git(['status', '--porcelain'], repo).replace(/.*role-calls.*\n?/g, '').trim(), '', 'nothing left uncommitted');

    assert.ok(fs.readFileSync(path.join(repo, '.bastion', 'map.json')).equals(mapBytes), 'map.json is byte-identical');
    assert.equal(git(['diff', '--name-only', 'HEAD~1', 'HEAD', '--', '.bastion/map.json'], repo), '');
  });

  it('also scans when --lock is set and puts plan.json into the test commit, not the lock commit', async () => {
    const { repo } = scanRepo({ map: mapWithoutN2Dep(), mul: MUL_TEST_IMPORTING_ADD });
    const { result, out } = await captureConsole(() => runTests({ cwd: repo, lock: true }));
    assert.equal(result, 0, out);
    assert.deepEqual(readPlan(repo).nodes.find((n) => n.id === 'n2')?.dependsOn, ['n1']);
    assert.equal(git(LAST_PLAN_COMMIT, repo), 'test(bastion): acceptance tests');
    assert.equal(git(['log', '-1', '--format=%s'], repo), 'test(bastion): lock acceptance tests');
    assert.ok(fs.existsSync(path.join(repo, LOCK_REL)));
  });

  it('prints nothing and leaves plan.json and the commit alone when no dependency is missing', async () => {
    const { repo } = scanRepo({ mul: MUL_TEST_IMPORTING_ADD }); // sample map: n2 already depends on n1
    const planBefore = fs.readFileSync(path.join(repo, '.bastion', 'plan.json'));
    const { result, out } = await captureConsole(() => runTests({ cwd: repo }));
    assert.equal(result, 0);
    assert.doesNotMatch(out, /added dependency/);
    assert.ok(fs.readFileSync(path.join(repo, '.bastion', 'plan.json')).equals(planBefore));
    const files = git(['show', '--name-only', '--format=', 'HEAD'], repo).split(/\r?\n/).filter(Boolean).sort();
    assert.deepEqual(files, ['tests/add.test.mjs', 'tests/mul.test.mjs']);
  });

  it('does nothing and does not fail when there is no plan.json', async () => {
    const { repo } = scanRepo({ map: mapWithoutN2Dep(), mul: MUL_TEST_IMPORTING_ADD, plan: null });
    const { result, out, err } = await captureConsole(() => runTests({ cwd: repo }));
    assert.equal(result, 0, err);
    assert.doesNotMatch(out, /added dependency/);
    assert.equal(fs.existsSync(path.join(repo, '.bastion', 'plan.json')), false, 'no plan.json is invented');
    const files = git(['show', '--name-only', '--format=', 'HEAD'], repo).split(/\r?\n/).filter(Boolean).sort();
    assert.deepEqual(files, ['tests/add.test.mjs', 'tests/mul.test.mjs']);
  });

  it('an import that would close a cycle is reported and returns 1 (round 5, H3); plan.json and map.json unchanged', async () => {
    // n2 depends on n1 (sample map), but the test of n1 imports n2's file
    const { repo, mapBytes } = scanRepo({ add: ADD_TEST_IMPORTING_MUL });
    const planBefore = fs.readFileSync(path.join(repo, '.bastion', 'plan.json'));
    const { result, out, err } = await captureConsole(() => runTests({ cwd: repo }));
    assert.equal(result, 1, err);
    assert.ok(
      err.split(/\r?\n/).includes('[bastion] tests: the test of n1 imports src/mul.mjs owned by n2, but n2 depends on n1; fix the map.'),
      err,
    );
    assert.doesNotMatch(out, /added dependency/);
    assert.ok(fs.readFileSync(path.join(repo, '.bastion', 'plan.json')).equals(planBefore), 'the cycle edge is not added');
    assert.ok(fs.readFileSync(path.join(repo, '.bastion', 'map.json')).equals(mapBytes));
    assert.notEqual(git(['log', '-1', '--format=%s'], repo), 'test(bastion): acceptance tests', 'nothing is committed');
  });
});

// ---------------------------------------------------------------- identity

const ID_VARS = [
  'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM',
  'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL',
] as const;

/** Remove the repo's local identity and hide every other git config for the duration of fn; restores everything. */
async function withoutGitIdentity<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  git(['config', '--unset', 'user.email'], repo);
  git(['config', '--unset', 'user.name'], repo);
  git(['config', 'user.useConfigOnly', 'true'], repo);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bastion-v11-gitcfg-'));
  const empty = path.join(dir, 'empty.gitconfig');
  fs.writeFileSync(empty, '');
  const saved = new Map<string, string | undefined>(ID_VARS.map((k) => [k, process.env[k]]));
  for (const k of ID_VARS) delete process.env[k];
  process.env.GIT_CONFIG_GLOBAL = empty;
  process.env.GIT_CONFIG_SYSTEM = empty;
  try {
    return await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const authorOf = (repo: string, n = 1): string[] => git(['log', `-${n}`, '--format=%ae|%an|%ce'], repo).split(/\r?\n/);

function scaffoldRepo(): string {
  return createRoleRepo({
    fixtures: { worker: { files: { ...SAMPLE_FILES.stubs } } },
    files: { '.bastion/map.json': JSON.stringify(sampleMap(), null, 2), '.bastion/interfaces.md': '# Interfaces\n' },
  });
}

function testsRepo(): string {
  return createRoleRepo({
    fixtures: testerFixtures(T['tests/add.test.mjs'], T['tests/mul.test.mjs']),
    files: { '.bastion/map.json': JSON.stringify(sampleMap(), null, 2), '.bastion/interfaces.md': '# Interfaces\n', ...SAMPLE_FILES.stubs },
  });
}

describe('v1.1 commits without a git identity', () => {
  it('runScaffold commits as bastion@local and does not write an identity into the repo config', async () => {
    const repo = scaffoldRepo();
    const { result, err } = await withoutGitIdentity(repo, () => captureConsole(() => runScaffold({ cwd: repo })));
    assert.equal(result, 0, err);
    assert.equal(git(['log', '-1', '--format=%s'], repo), 'chore(bastion): scaffold');
    assert.deepEqual(authorOf(repo), ['bastion@local|bastion|bastion@local']);
    const cfg = spawnSync('git', ['config', '--local', 'user.email'], { cwd: repo, encoding: 'utf8' });
    assert.notEqual(cfg.status, 0, 'user.email was not persisted');
  });

  it('runTests({ lock: true }) makes both commits as bastion@local', async () => {
    const repo = testsRepo();
    const { result, err } = await withoutGitIdentity(repo, () => captureConsole(() => runTests({ cwd: repo, lock: true })));
    assert.equal(result, 0, err);
    assert.equal(git(['log', '-2', '--format=%s'], repo), 'test(bastion): lock acceptance tests\ntest(bastion): acceptance tests');
    assert.deepEqual(authorOf(repo, 2), ['bastion@local|bastion|bastion@local', 'bastion@local|bastion|bastion@local']);
  });

  it('runTests without lock commits as bastion@local too', async () => {
    const repo = testsRepo();
    const { result, err } = await withoutGitIdentity(repo, () => captureConsole(() => runTests({ cwd: repo })));
    assert.equal(result, 0, err);
    assert.deepEqual(authorOf(repo), ['bastion@local|bastion|bastion@local']);
  });

  it('puts the process environment back after the helper (guard for the other tests)', () => {
    const before = process.env.GIT_CONFIG_GLOBAL;
    const repo = createTempGitRepo();
    return withoutGitIdentity(repo, async () => undefined).then(() => {
      assert.equal(process.env.GIT_CONFIG_GLOBAL, before);
    });
  });
});

describe('v1.1 commits with a configured identity keep that identity', () => {
  it('runScaffold and runTests({ lock: true }) commit as the configured user', async () => {
    const repo = scaffoldRepo();
    assert.equal((await captureConsole(() => runScaffold({ cwd: repo }))).result, 0);
    assert.deepEqual(authorOf(repo), ['test@bastion.local|Bastion Test|test@bastion.local']);

    const repo2 = testsRepo();
    const r = await captureConsole(() => runTests({ cwd: repo2, lock: true }));
    assert.equal(r.result, 0, r.err);
    assert.deepEqual(authorOf(repo2, 2), [
      'test@bastion.local|Bastion Test|test@bastion.local',
      'test@bastion.local|Bastion Test|test@bastion.local',
    ]);
  });
});

describe('v1.1 flow "approved map" commit identity', () => {
  const REQ = 'A tiny calculator with add and mul.';

  /** Plan + approve with the configured identity, then run flow again; the worker fails so flow stops after the commit. */
  async function approvedMapAuthor(withIdentity: boolean): Promise<string[]> {
    const repo = createRoleRepo({
      fixtures: { planner: { output: sampleMap() }, blind: { output: sampleMap() }, worker: { exit: 1 } },
    });
    assert.equal((await captureConsole(() => runFlow({ cwd: repo, requirement: REQ, tier: 'city' }))).result, 2);
    assert.equal(runReview({ cwd: repo, approve: true }), 0);
    const second = withIdentity
      ? await captureConsole(() => runFlow({ cwd: repo, tier: 'city' }))
      : await withoutGitIdentity(repo, () => captureConsole(() => runFlow({ cwd: repo, tier: 'city' })));
    assert.equal(second.result, 1, 'scaffold fails on purpose, after the map commit');
    return git(['log', '--grep=approved map', '--format=%s|%ae|%an|%ce'], repo).split(/\r?\n/);
  }

  it('is made with the configured identity, not forced to bastion@local', async () => {
    assert.deepEqual(await approvedMapAuthor(true), ['chore(bastion): approved map|test@bastion.local|Bastion Test|test@bastion.local']);
  });

  it('falls back to bastion@local when no identity is configured', async () => {
    assert.deepEqual(await approvedMapAuthor(false), ['chore(bastion): approved map|bastion@local|bastion|bastion@local']);
  });
});
