// v1.1 hardening (round 5) - `bastion audit` no longer skips an uncheckable merge silently.
import * as assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { runAudit } from '../src/commands/audit.js';
import { runInit } from '../src/commands/init.js';
import { runLock } from '../src/commands/lock.js';
import {
  captureConsole,
  cleanupTempRepos,
  createTempGitRepo,
  git,
  writeRepoFile,
} from './v04-helpers.js';

afterEach(cleanupTempRepos);

const TEST_REL = 'tests/a.test.mjs';
const LOCK_REL = '.bastion/lock.json';

function testSource(expected: number): string {
  return `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { a } from '../src/a.mjs';\ntest('a is ${expected}', () => { assert.equal(a(), ${expected}); });\n`;
}

function commitAll(repo: string, msg: string): void {
  git(['add', '-A'], repo);
  git(['commit', '-m', msg], repo);
}

/** Branch off main, commit one file, merge back with --no-ff. Returns the merge sha. */
function plainMerge(repo: string, name: string, file: string): string {
  git(['checkout', '-b', name], repo);
  writeRepoFile(repo, file, `${name}\n`);
  commitAll(repo, `work ${name}`);
  git(['checkout', 'main'], repo);
  git(['merge', '--no-ff', name, '-m', `merge ${name}`], repo);
  return git(['rev-parse', 'HEAD'], repo);
}

/** Repo with `preMerges` --no-ff merges made BEFORE bastion init/lock, then init + lock committed on main. */
function repoWithPreLockMerges(preMerges: number): { repo: string; preShas: string[] } {
  const repo = createTempGitRepo();
  git(['config', 'core.autocrlf', 'false'], repo);
  writeRepoFile(repo, 'README.md', 'x\n');
  commitAll(repo, 'init');
  const preShas: string[] = [];
  for (let i = 0; i < preMerges; i++) preShas.push(plainMerge(repo, `pre${i}`, `pre${i}.txt`));
  runInit({ cwd: repo, testCommand: 'node --test tests/*.test.mjs', baseBranch: 'main' });
  writeRepoFile(repo, 'src/a.mjs', 'export function a() { return 0; }\n');
  writeRepoFile(repo, TEST_REL, testSource(1));
  commitAll(repo, 'chore: baseline');
  assert.equal(runLock({ cwd: repo }), 0);
  git(['add', LOCK_REL], repo);
  git(['commit', '-m', 'chore: lock'], repo);
  return { repo, preShas };
}

async function audit(repo: string): Promise<{ code: number; out: string; err: string }> {
  const { result, out, err } = await captureConsole(() => runAudit({ cwd: repo }));
  return { code: result, out, err };
}

const NO_BYPASS = /no locked-scope bypasses detected/;
const ALL_SKIPPED = /\[bastion\] Audit: no merge could be checked \((\d+) skipped\)\./;

describe('v1.1 round 5 audit: skipped merges leave a trace', () => {
  it('a repo whose only merge predates the lock prints [SKIP] and "no merge could be checked (1 skipped)", not the clean line, exit 0', async () => {
    const { repo, preShas } = repoWithPreLockMerges(1);
    const { code, out, err } = await audit(repo);
    assert.equal(code, 0, err);
    const short = preShas[0]!.slice(0, 8);
    assert.ok(
      out.includes(`[SKIP] ${short} (merge pre0) - its parent has no readable bastion config/lock`),
      `missing exact SKIP line in:\n${out}`
    );
    assert.match(out, /\[bastion\] Audit: no merge could be checked \(1 skipped\)\./);
    assert.doesNotMatch(out, NO_BYPASS);
    assert.doesNotMatch(out, /merge\(s\) checked/);
    assert.doesNotMatch(out, /\[PASS\]/);
  });

  it('every merge skipped (2 of 2) reports the skipped count, never the clean line', async () => {
    const { repo, preShas } = repoWithPreLockMerges(2);
    const { code, out } = await audit(repo);
    assert.equal(code, 0);
    for (const sha of preShas) assert.ok(out.includes(`[SKIP] ${sha.slice(0, 8)} `), `no SKIP for ${sha}`);
    assert.match(out, /\[bastion\] Audit: no merge could be checked \(2 skipped\)\./);
    assert.doesNotMatch(out, NO_BYPASS);
  });

  it('one merge before the lock and one clean merge after: SKIP, usual final line, then "1 merge(s) checked, 1 skipped"', async () => {
    const { repo, preShas } = repoWithPreLockMerges(1);
    const postSha = plainMerge(repo, 'post', 'post.txt');
    const { code, out, err } = await audit(repo);
    assert.equal(code, 0, err);
    assert.ok(out.includes(`[SKIP] ${preShas[0]!.slice(0, 8)} (merge pre0) - its parent has no readable bastion config/lock`));
    assert.ok(out.includes(`[PASS] ${postSha.slice(0, 8)} (merge post)`));
    assert.doesNotMatch(out, ALL_SKIPPED);
    const finalIdx = out.indexOf('[bastion] Audit complete: no locked-scope bypasses detected.');
    const extra = '[bastion] Audit: 1 merge(s) checked, 1 skipped (not covered by this audit).';
    const extraIdx = out.indexOf(extra);
    assert.ok(finalIdx >= 0, `usual final line missing:\n${out}`);
    assert.ok(extraIdx >= 0, `extra summary line missing:\n${out}`);
    assert.ok(extraIdx > finalIdx, 'extra line must follow the usual final line');
    assert.ok(out.indexOf('[SKIP]') < finalIdx, 'SKIP line is printed in the loop, before the final line');
    assert.equal(out.trimEnd().split(/\r?\n/).pop(), extra, 'extra line is the last line');
  });

  it('counts: 2 skipped + 2 checked -> "2 merge(s) checked, 2 skipped"', async () => {
    const { repo } = repoWithPreLockMerges(2);
    plainMerge(repo, 'post1', 'post1.txt');
    plainMerge(repo, 'post2', 'post2.txt');
    const { code, out } = await audit(repo);
    assert.equal(code, 0);
    assert.ok(out.includes('[bastion] Audit: 2 merge(s) checked, 2 skipped (not covered by this audit).'), out);
    assert.equal(out.split('[SKIP]').length - 1, 2);
  });

  it('only checked merges: output has no SKIP and no extra summary line', async () => {
    const { repo } = repoWithPreLockMerges(0);
    plainMerge(repo, 'post', 'post.txt');
    const { code, out } = await audit(repo);
    assert.equal(code, 0);
    assert.match(out, NO_BYPASS);
    assert.doesNotMatch(out, /\[SKIP\]/);
    assert.doesNotMatch(out, /merge\(s\) checked/);
    assert.doesNotMatch(out, /no merge could be checked/);
    assert.match(out, /\[PASS\]/);
  });

  it('a bypass after the lock plus a skipped merge still exits 1 and reports the bypass (no "checked/skipped" or "all skipped" line)', async () => {
    const { repo, preShas } = repoWithPreLockMerges(1);
    git(['checkout', '-b', 'sneaky'], repo);
    writeRepoFile(repo, TEST_REL, testSource(99));
    commitAll(repo, 'test: weaken');
    git(['checkout', 'main'], repo);
    git(['merge', '--no-ff', 'sneaky', '-m', 'merge sneaky'], repo);
    const { code, out, err } = await audit(repo);
    assert.equal(code, 1);
    assert.match(err, /\[FAIL\].*merge sneaky/);
    assert.ok(err.includes(TEST_REL));
    assert.match(err, /Audit found 1 merge\(s\) that bypassed locked scope/);
    assert.ok(out.includes(`[SKIP] ${preShas[0]!.slice(0, 8)} (merge pre0)`), `SKIP missing:\n${out}`);
    assert.doesNotMatch(out + err, /merge\(s\) checked/);
    assert.doesNotMatch(out + err, ALL_SKIPPED);
    assert.doesNotMatch(out, NO_BYPASS);
  });
});
