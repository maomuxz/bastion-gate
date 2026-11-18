// v1.0 F8 - `bastion audit` accepts a merge that touched locked files only when it carries an authorised lock amendment.
import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { isAuthorizedAmendment, runAudit } from '../src/commands/audit.js';
import { runInit } from '../src/commands/init.js';
import { runLock } from '../src/commands/lock.js';
import {
  captureConsole,
  cleanupTempRepos,
  createTempGitRepo,
  git,
  readJson,
  writeRepoFile,
} from './v04-helpers.js';

afterEach(cleanupTempRepos);

const TEST_REL = 'tests/a.test.mjs';
const LOCK_REL = '.bastion/lock.json';
const CONFIG_REL = '.bastion/config.json';

function testSource(expected: number): string {
  return `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { a } from '../src/a.mjs';\ntest('a is ${expected}', () => { assert.equal(a(), ${expected}); });\n`;
}

/** A repo on main with a red locked test tests/a.test.mjs (a() stub returns 0, test expects 1). */
function lockedRepo(): string {
  const repo = createTempGitRepo();
  // keep blobs byte-identical to the working copy so sha256 comparisons are platform-independent
  git(['config', 'core.autocrlf', 'false'], repo);
  runInit({ cwd: repo, testCommand: 'node --test tests/*.test.mjs', baseBranch: 'main' });
  writeRepoFile(repo, 'src/a.mjs', 'export function a() { return 0; }\n');
  writeRepoFile(repo, TEST_REL, testSource(1));
  git(['add', '.'], repo);
  git(['commit', '-m', 'chore: baseline'], repo);
  assert.equal(runLock({ cwd: repo }), 0);
  git(['add', LOCK_REL], repo);
  git(['commit', '-m', 'chore: lock'], repo);
  return repo;
}

function commitAll(repo: string, msg: string): void {
  git(['add', '-A'], repo);
  git(['commit', '-m', msg], repo);
}

/** Edit the locked test and amend the lock, both committed on the current branch. */
async function editTestAndAmend(repo: string, expected: number): Promise<void> {
  writeRepoFile(repo, TEST_REL, testSource(expected));
  commitAll(repo, `test: expect ${expected}`);
  const { result } = await captureConsole(() => runLock({ cwd: repo, amend: true, reason: 'test was wrong' }));
  assert.equal(result, 0, 'fixture: amend must succeed');
  commitAll(repo, 'chore: amend lock');
}

/** Branch off main, run `work`, then merge it back with --no-ff. Returns the merge sha. */
async function mergeBranch(repo: string, name: string, work: () => Promise<void> | void): Promise<string> {
  git(['checkout', '-b', name], repo);
  await work();
  git(['checkout', 'main'], repo);
  git(['merge', '--no-ff', name, '-m', `merge ${name}`], repo);
  return git(['rev-parse', 'HEAD'], repo);
}

async function audit(repo: string): Promise<{ code: number; out: string; err: string }> {
  const { result, out, err } = await captureConsole(() => runAudit({ cwd: repo }));
  return { code: result, out, err };
}

describe('v1.0 F8 audit: authorised lock amendments', () => {
  it('passes a --no-ff merge carrying a properly amended lock and reports it as an authorised amendment', async () => {
    const repo = lockedRepo();
    await mergeBranch(repo, 'fix-test', () => editTestAndAmend(repo, 2));
    const { code, out, err } = await audit(repo);
    assert.equal(code, 0, err);
    assert.match(out, /authorised lock amendment/);
    assert.doesNotMatch(err, /\[FAIL\]/);
  });

  it('fails a merge that edits a locked test without amending the lock', async () => {
    const repo = lockedRepo();
    await mergeBranch(repo, 'sneaky', () => {
      writeRepoFile(repo, TEST_REL, testSource(99));
      commitAll(repo, 'test: weaken');
    });
    const { code, out, err } = await audit(repo);
    assert.equal(code, 1);
    assert.match(err, /\[FAIL\]/);
    assert.ok(err.includes(TEST_REL));
    assert.doesNotMatch(out, /authorised lock amendment/);
  });

  it('fails when the amended lock records a sha256 that does not match the merged test content', async () => {
    const repo = lockedRepo();
    await mergeBranch(repo, 'bait-switch', async () => {
      await editTestAndAmend(repo, 2);
      // the lock was amended for expectation 2, but the merged test says something else
      writeRepoFile(repo, TEST_REL, testSource(77));
      commitAll(repo, 'test: swap after amend');
    });
    const { code, err } = await audit(repo);
    assert.equal(code, 1);
    assert.ok(err.includes(TEST_REL));
  });

  it('fails when a touched locked-glob file is missing from the amended lock', async () => {
    const repo = lockedRepo();
    await mergeBranch(repo, 'extra-test', async () => {
      await editTestAndAmend(repo, 2);
      writeRepoFile(repo, 'tests/b.test.mjs', testSource(5).replace('a is', 'b is'));
      commitAll(repo, 'test: add unlisted test');
    });
    const { code, err } = await audit(repo);
    assert.equal(code, 1);
    assert.ok(err.includes('tests/b.test.mjs'));
  });

  it('fails a merge that touches .bastion/config.json even with an otherwise valid amendment', async () => {
    const repo = lockedRepo();
    await mergeBranch(repo, 'config-tamper', async () => {
      const cfgPath = path.join(repo, CONFIG_REL);
      const cfg = readJson<Record<string, unknown>>(cfgPath);
      fs.writeFileSync(cfgPath, JSON.stringify({ ...cfg, extraLockedPaths: [...((cfg.extraLockedPaths as string[]) ?? []), 'nothing-here.txt'] }, null, 2) + '\n');
      commitAll(repo, 'chore: touch config');
      await editTestAndAmend(repo, 2);
    });
    const { code, err } = await audit(repo);
    assert.equal(code, 1);
    assert.ok(err.includes(CONFIG_REL));
  });

  it('fails when lock.json was hand-edited to match new content without adding an amendment', async () => {
    const repo = lockedRepo();
    await mergeBranch(repo, 'forged-lock', () => {
      writeRepoFile(repo, TEST_REL, testSource(99));
      const lockPath = path.join(repo, LOCK_REL);
      const lock = readJson<{ lockedFiles: Array<{ path: string; sha256: string }> }>(lockPath);
      for (const f of lock.lockedFiles) {
        if (f.path === TEST_REL) f.sha256 = createHash('sha256').update(fs.readFileSync(path.join(repo, TEST_REL))).digest('hex');
      }
      fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
      commitAll(repo, 'chore: forge lock');
    });
    const { code } = await audit(repo);
    assert.equal(code, 1);
  });

  it('reports a good amendment merge as PASS and a later bad merge as FAIL, exiting 1', async () => {
    const repo = lockedRepo();
    await mergeBranch(repo, 'fix-test', () => editTestAndAmend(repo, 2));
    await mergeBranch(repo, 'sneaky', () => {
      writeRepoFile(repo, TEST_REL, testSource(3));
      commitAll(repo, 'test: weaken again');
    });
    const { code, out, err } = await audit(repo);
    assert.equal(code, 1);
    assert.match(out, /authorised lock amendment/);
    assert.match(err, /\[FAIL\].*merge sneaky/);
    assert.doesNotMatch(err, /\[FAIL\].*merge fix-test/);
  });
});

describe('v1.0 F8 isAuthorizedAmendment (unit)', () => {
  it('is true for a properly amended merge, with or without lock.json listed in touched', async () => {
    const repo = lockedRepo();
    const sha = await mergeBranch(repo, 'fix-test', () => editTestAndAmend(repo, 2));
    assert.equal(isAuthorizedAmendment(repo, sha, [TEST_REL, LOCK_REL]), true);
    assert.equal(isAuthorizedAmendment(repo, sha, [TEST_REL]), true);
    assert.equal(isAuthorizedAmendment(repo, sha, [LOCK_REL]), true);
  });

  it('is false when touched includes config.json or a path absent from the new lock', async () => {
    const repo = lockedRepo();
    const sha = await mergeBranch(repo, 'fix-test', () => editTestAndAmend(repo, 2));
    assert.equal(isAuthorizedAmendment(repo, sha, [TEST_REL, CONFIG_REL]), false);
    assert.equal(isAuthorizedAmendment(repo, sha, [TEST_REL, 'tests/unlisted.test.mjs']), false);
  });

  it('is false when the lock did not gain amendments', async () => {
    const repo = lockedRepo();
    const sha = await mergeBranch(repo, 'sneaky', () => {
      writeRepoFile(repo, TEST_REL, testSource(99));
      commitAll(repo, 'test: weaken');
    });
    assert.equal(isAuthorizedAmendment(repo, sha, [TEST_REL]), false);
  });

  it('is false when the recorded sha256 differs from the content at sha', async () => {
    const repo = lockedRepo();
    const sha = await mergeBranch(repo, 'bait-switch', async () => {
      await editTestAndAmend(repo, 2);
      writeRepoFile(repo, TEST_REL, testSource(77));
      commitAll(repo, 'test: swap after amend');
    });
    assert.equal(isAuthorizedAmendment(repo, sha, [TEST_REL]), false);
  });

  it('is false (does not throw) when the lock is missing at sha or at its first parent', async () => {
    const repo = lockedRepo();
    // lock removed on the branch
    const noLockSha = await mergeBranch(repo, 'drop-lock', () => {
      git(['rm', LOCK_REL], repo);
      git(['commit', '-m', 'chore: drop lock'], repo);
    });
    assert.equal(isAuthorizedAmendment(repo, noLockSha, [LOCK_REL]), false);

    // first parent has no lock at all
    const bare = createTempGitRepo();
    writeRepoFile(bare, 'README.md', 'x\n');
    commitAll(bare, 'init');
    git(['checkout', '-b', 'f'], bare);
    writeRepoFile(bare, TEST_REL, testSource(1));
    commitAll(bare, 'add test');
    git(['checkout', 'main'], bare);
    git(['merge', '--no-ff', 'f', '-m', 'merge f'], bare);
    const bareSha = git(['rev-parse', 'HEAD'], bare);
    assert.equal(isAuthorizedAmendment(bare, bareSha, [TEST_REL]), false);
  });
});
