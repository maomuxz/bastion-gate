// P9: bastion audit --regress — find the first merge on first-parent history that breaks a command.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { findRegression, runRegress } from '../src/commands/regress.js';
import { runInit } from '../src/commands/init.js';
import { captureConsole, cleanupTempRepos, createTempGitRepo, git, writeRepoFile } from './v04-helpers.js';

afterEach(() => cleanupTempRepos());

const tmpLogs: string[] = [];
afterEach(() => {
  while (tmpLogs.length) fs.rmSync(tmpLogs.pop()!, { force: true });
});

interface Fixture {
  repo: string;
  log: string;
  /** merge commit shas on work, oldest first */
  merges: string[];
  baseSha: string;
}

/** main: passing baseline. work: three --no-ff merges; the one that sets flag.txt=bad is merge #2 (and #3 stays broken). */
function buildRepo(breakAt: number | null): Fixture {
  const repo = createTempGitRepo();
  const log = path.join(os.tmpdir(), `bastion-regress-${path.basename(repo)}.log`);
  tmpLogs.push(log);
  runInit({ cwd: repo, testCommand: 'node check.mjs', baseBranch: 'main' });
  writeRepoFile(
    repo,
    'check.mjs',
    `import * as fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(log)}, process.cwd() + '\\n');\n` +
      `if (fs.readFileSync('flag.txt', 'utf8').trim() === 'bad') process.exit(1);\n`
  );
  writeRepoFile(repo, 'flag.txt', 'ok\n');
  git(['add', '.'], repo);
  git(['commit', '-m', 'chore: baseline'], repo);
  const baseSha = git(['rev-parse', 'HEAD'], repo);
  git(['checkout', '-b', 'work'], repo);
  const merges: string[] = [];
  for (let i = 1; i <= 3; i++) {
    git(['checkout', '-b', `feat${i}`], repo);
    writeRepoFile(repo, `f${i}.txt`, `feature ${i}\n`);
    if (breakAt === i) writeRepoFile(repo, 'flag.txt', 'bad\n');
    git(['add', '.'], repo);
    git(['commit', '-m', `feat: feature ${i}`], repo);
    git(['checkout', 'work'], repo);
    git(['merge', '--no-ff', `feat${i}`, '-m', `bastion: merge feat${i}`], repo);
    merges.push(git(['rev-parse', 'HEAD'], repo));
  }
  return { repo, log, merges, baseSha };
}

function sameSha(a: string, b: string): boolean {
  return a.length > 0 && b.length > 0 && (a.startsWith(b) || b.startsWith(a));
}

describe('P9 regress', () => {
  it('finds the first breaking merge (default base = config.baseBranch)', async () => {
    const f = buildRepo(2);
    const { result } = await captureConsole(() => findRegression({ cwd: f.repo, command: 'node check.mjs' }));
    assert.ok(result.culprit, `expected a culprit, got: ${result.message}`);
    assert.ok(sameSha(result.culprit.sha, f.merges[1]), `culprit ${result.culprit.sha} should be merge #2 ${f.merges[1]}`);
    assert.match(result.culprit.subject, /merge feat2/);
    assert.ok(result.checked >= 1 && result.checked <= 7, `checked=${result.checked}`);
  });

  it('runs the command in temporary worktrees, never in the repo, and cleans up', async () => {
    const f = buildRepo(2);
    writeRepoFile(f.repo, 'dirty.txt', 'uncommitted\n');
    const headBefore = git(['rev-parse', 'HEAD'], f.repo);
    await captureConsole(() => findRegression({ cwd: f.repo, command: 'node check.mjs' }));
    const cwds = fs.readFileSync(f.log, 'utf8').split(/\r?\n/).filter(Boolean);
    assert.ok(cwds.length >= 2, 'command must have run on several commits');
    for (const c of cwds) assert.notEqual(path.resolve(c).toLowerCase(), path.resolve(f.repo).toLowerCase(), 'command ran in the main working tree');
    // worktrees removed: only the main one is left, and the directories are gone
    const wt = git(['worktree', 'list', '--porcelain'], f.repo).split(/\r?\n/).filter((l) => l.startsWith('worktree '));
    assert.equal(wt.length, 1, `leftover worktrees: ${wt.join(', ')}`);
    for (const c of new Set(cwds)) assert.equal(fs.existsSync(c), false, `temp worktree still exists: ${c}`);
    // caller state untouched
    assert.equal(git(['rev-parse', 'HEAD'], f.repo), headBefore);
    assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], f.repo), 'work');
    assert.equal(fs.readFileSync(path.join(f.repo, 'dirty.txt'), 'utf8'), 'uncommitted\n');
  });

  it('first culprit only: later merges that stay broken are not blamed', async () => {
    const f = buildRepo(2);
    // with base = the culprit itself, merge #3 fails but its first parent already failed -> no culprit
    const { result } = await captureConsole(() => findRegression({ cwd: f.repo, command: 'node check.mjs', base: f.merges[1] }));
    assert.equal(result.culprit, undefined);
    assert.ok(result.message.length > 0);
  });

  it('respects an explicit --base before the culprit', async () => {
    const f = buildRepo(2);
    const { result } = await captureConsole(() => findRegression({ cwd: f.repo, command: 'node check.mjs', base: f.merges[0] }));
    assert.ok(result.culprit && sameSha(result.culprit.sha, f.merges[1]));
    const viaMain = await captureConsole(() => findRegression({ cwd: f.repo, command: 'node check.mjs', base: f.baseSha }));
    assert.ok(viaMain.result.culprit && sameSha(viaMain.result.culprit.sha, f.merges[1]));
  });

  it('breaking change in the very first merge is found (first parent = base passes)', async () => {
    const f = buildRepo(1);
    const { result } = await captureConsole(() => findRegression({ cwd: f.repo, command: 'node check.mjs' }));
    assert.ok(result.culprit && sameSha(result.culprit.sha, f.merges[0]));
  });

  it('no breaking merge -> no culprit, explanatory message', async () => {
    const f = buildRepo(null);
    const { result } = await captureConsole(() => findRegression({ cwd: f.repo, command: 'node check.mjs' }));
    assert.equal(result.culprit, undefined);
    assert.ok(result.checked >= 1, 'must actually run the command');
    assert.ok(result.message.length > 10 && !/not implemented/i.test(result.message));
    const wt = git(['worktree', 'list', '--porcelain'], f.repo).split(/\r?\n/).filter((l) => l.startsWith('worktree '));
    assert.equal(wt.length, 1);
  });

  it('no merges after base -> checked 0 or more, no culprit, no crash', async () => {
    const f = buildRepo(2);
    const { result } = await captureConsole(() => findRegression({ cwd: f.repo, command: 'node check.mjs', base: 'HEAD' }));
    assert.equal(result.culprit, undefined);
    assert.ok(result.message.length > 0 && !/not implemented/i.test(result.message));
  });

  it('runRegress: culprit -> prints git revert -m 1 <sha>, returns 1', async () => {
    const f = buildRepo(2);
    const { result: code, out } = await captureConsole(() => runRegress({ cwd: f.repo, command: 'node check.mjs' }));
    assert.equal(code, 1);
    const m = out.match(/git revert -m 1 ([0-9a-f]{7,40})/);
    assert.ok(m, `no revert hint in output: ${out}`);
    assert.ok(sameSha(m[1], f.merges[1]));
  });

  it('runRegress: clean history -> returns 0 and no revert hint', async () => {
    const f = buildRepo(null);
    const { result: code, out } = await captureConsole(() => runRegress({ cwd: f.repo, command: 'node check.mjs' }));
    assert.equal(code, 0);
    assert.doesNotMatch(out, /git revert/);
    assert.ok(out.trim().length > 0 && !/not implemented/i.test(out));
  });
});
