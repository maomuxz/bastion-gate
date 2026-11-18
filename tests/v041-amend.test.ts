// M1 (F1) - lock --amend can strengthen a test after the implementation exists:
// if the suite is green on HEAD, red-first is verified against the previous lock's baseline instead.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { runInit } from '../src/commands/init.js';
import { runLock } from '../src/commands/lock.js';
import { captureConsole, cleanupTempRepos, createTempGitRepo, git, readJson, writeRepoFile } from './v04-helpers.js';

afterEach(cleanupTempRepos);

interface LockFile {
  baseCommit: string;
  lockedFiles: Array<{ path: string; sha256: string }>;
  amendments?: Array<{ reason: string; previousBaseCommit: string; newBaseCommit: string; redVerifiedAgainst?: string }>;
}

const TEST_HEADER = `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/calc.mjs';\n`;

/** Locked red test on a stub, then a real implementation committed on top (suite now green). */
function lockedAndImplemented(): { repo: string; firstBase: string } {
  const repo = createTempGitRepo();
  runInit({ cwd: repo, testCommand: 'node --test tests/calc.test.mjs', baseBranch: 'main' });
  writeRepoFile(repo, 'src/calc.mjs', 'export function add() { return 0; }\n');
  writeRepoFile(repo, 'tests/calc.test.mjs', `${TEST_HEADER}test('adds', () => { assert.equal(add(2, 3), 5); });\n`);
  git(['add', '.'], repo);
  git(['commit', '-m', 'baseline'], repo);
  assert.equal(runLock({ cwd: repo }), 0);
  const firstBase = readJson<LockFile>(path.join(repo, '.bastion', 'lock.json')).baseCommit;
  git(['add', '.bastion/lock.json'], repo);
  git(['commit', '-m', 'lock'], repo);
  writeRepoFile(repo, 'src/calc.mjs', 'export function add(a, b) { return a + b; }\n');
  git(['commit', '-am', 'implement add'], repo);
  return { repo, firstBase };
}

describe('v0.4.1 M1 lock --amend after implementation', () => {
  it('accepts a strengthened test that is green on HEAD but red on the previous baseline', async () => {
    const { repo, firstBase } = lockedAndImplemented();
    writeRepoFile(
      repo,
      'tests/calc.test.mjs',
      `${TEST_HEADER}test('adds', () => { assert.equal(add(2, 3), 5); assert.equal(add(10, 5), 15); });\n`
    );
    git(['commit', '-am', 'strengthen test'], repo);

    const { result } = await captureConsole(() => runLock({ cwd: repo, amend: true, reason: 'mutant survived' }));
    assert.equal(result, 0);
    const lock = readJson<LockFile>(path.join(repo, '.bastion', 'lock.json'));
    assert.equal(lock.baseCommit, git(['rev-parse', 'HEAD'], repo));
    const last = lock.amendments?.at(-1);
    assert.ok(last, 'an amendment is recorded');
    assert.equal(last!.reason, 'mutant survived');
    assert.equal(last!.redVerifiedAgainst, firstBase, 'red-first was checked against the earlier baseline');
    const entry = lock.lockedFiles.find((f) => f.path === 'tests/calc.test.mjs');
    assert.ok(entry, 'test still locked');
    assert.equal(git(['worktree', 'list'], repo).split(/\r?\n/).length, 1, 'temporary worktree is removed');
  });

  it('rejects an amended test that also passes on the previous baseline (tautology), leaving the lock unchanged', async () => {
    const { repo } = lockedAndImplemented();
    const before = fs.readFileSync(path.join(repo, '.bastion', 'lock.json'), 'utf8');
    writeRepoFile(repo, 'tests/calc.test.mjs', `${TEST_HEADER}test('adds', () => { assert.equal(typeof add, 'function'); });\n`);
    git(['commit', '-am', 'weaken test'], repo);

    const { result } = await captureConsole(() => runLock({ cwd: repo, amend: true, reason: 'sneaky' }));
    assert.equal(result, 1);
    assert.equal(fs.readFileSync(path.join(repo, '.bastion', 'lock.json'), 'utf8'), before);
    assert.equal(git(['worktree', 'list'], repo).split(/\r?\n/).length, 1, 'temporary worktree is removed');
  });

  it('a normal red amend (suite still red on HEAD) keeps working and does not set redVerifiedAgainst', async () => {
    const repo = createTempGitRepo();
    runInit({ cwd: repo, testCommand: 'node --test tests/*.test.mjs', baseBranch: 'main' });
    writeRepoFile(repo, 'src/calc.mjs', 'export function add() { return 0; }\n');
    writeRepoFile(repo, 'tests/calc.test.mjs', `${TEST_HEADER}test('adds', () => { assert.equal(add(2, 3), 5); });\n`);
    git(['add', '.'], repo);
    git(['commit', '-m', 'baseline'], repo);
    assert.equal(runLock({ cwd: repo }), 0);
    git(['add', '.bastion/lock.json'], repo);
    git(['commit', '-m', 'lock'], repo);
    writeRepoFile(repo, 'tests/more.test.mjs', `${TEST_HEADER}test('adds more', () => { assert.equal(add(1, 1), 2); });\n`);
    git(['add', '.'], repo);
    git(['commit', '-m', 'another red test'], repo);

    const { result } = await captureConsole(() => runLock({ cwd: repo, amend: true, reason: 'new red test' }));
    assert.equal(result, 0);
    const last = readJson<LockFile>(path.join(repo, '.bastion', 'lock.json')).amendments?.at(-1);
    assert.ok(last);
    assert.equal(last!.redVerifiedAgainst, undefined);
  });
});
