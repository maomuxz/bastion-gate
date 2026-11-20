import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { runInit } from '../src/commands/init.js';
import { runMutate } from '../src/commands/mutate.js';
import { runTestCommand } from '../src/runner.js';
import { cleanupTempRepos, createTempGitRepo, git, writeRepoFile } from './v04-helpers.js';

// NOTE: the "never-ending" scripts below end by themselves after ~10 s. Against the old (stub) behaviour the
// call therefore returns late with exit 0 and the assertions fail (red) instead of hanging the whole test run.

const scratchDirs: string[] = [];

function scratchDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bastion-v11-'));
  scratchDirs.push(dir);
  return dir;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Poll up to `withinMs` until every pid is gone; returns the pids still alive. */
function stillAlive(pids: number[], withinMs = 5000): number[] {
  const deadline = Date.now() + withinMs;
  let alive = pids.filter(isAlive);
  while (alive.length > 0 && Date.now() < deadline) {
    sleepSync(100);
    alive = alive.filter(isAlive);
  }
  return alive;
}

function readPids(file: string): number[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\s+/).filter(Boolean).map(Number);
}

function captureSync<T>(fn: () => T): { result: T; out: string; err: string } {
  const origLog = console.log;
  const origErr = console.error;
  const out: string[] = [];
  const err: string[] = [];
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(' ')); };
  console.error = (...a: unknown[]) => { err.push(a.map(String).join(' ')); };
  try {
    return { result: fn(), out: out.join('\n'), err: err.join('\n') };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

afterEach(() => {
  cleanupTempRepos();
  while (scratchDirs.length > 0) {
    fs.rmSync(scratchDirs.pop()!, { recursive: true, force: true });
  }
});

describe('v1.1 runTestCommand timeout', { timeout: 60_000 }, () => {
  it('a command that finishes in time keeps its exit code and output, timedOut is not true', { timeout: 60_000 }, () => {
    const dir = scratchDir();
    fs.writeFileSync(path.join(dir, 'ok.mjs'), `console.log('fine-out'); console.error('fine-err');\n`);
    fs.writeFileSync(path.join(dir, 'bad.mjs'), `console.log('bad-out'); console.error('bad-err'); process.exit(3);\n`);

    const ok = runTestCommand('node ok.mjs', dir, 30_000);
    assert.equal(ok.exitCode, 0);
    assert.match(ok.stdout, /fine-out/);
    assert.match(ok.stderr, /fine-err/);
    assert.doesNotMatch(ok.stderr, /timed out/);
    assert.notEqual(ok.timedOut, true);

    const bad = runTestCommand('node bad.mjs', dir, 30_000);
    assert.equal(bad.exitCode, 3);
    assert.match(bad.stdout, /bad-out/);
    assert.match(bad.stderr, /bad-err/);
    assert.doesNotMatch(bad.stderr, /timed out/);
    assert.notEqual(bad.timedOut, true);
  });

  it('large output of a command that finishes in time is relayed completely', { timeout: 60_000 }, () => {
    const dir = scratchDir();
    fs.writeFileSync(
      path.join(dir, 'big.mjs'),
      `process.stdout.write('x'.repeat(400000) + 'END'); process.stderr.write('y'.repeat(100000) + 'ERR');\n`,
    );
    const withLimit = runTestCommand('node big.mjs', dir, 30_000);
    const without = runTestCommand('node big.mjs', dir);
    assert.equal(withLimit.exitCode, 0);
    assert.equal(withLimit.stdout, without.stdout);
    assert.equal(withLimit.stderr, without.stderr);
    assert.equal(withLimit.stdout.length, 400003);
    assert.notEqual(withLimit.timedOut, true);
  });

  it('without a positive timeoutMs a quick command behaves as before', { timeout: 60_000 }, () => {
    const dir = scratchDir();
    fs.writeFileSync(path.join(dir, 'q.mjs'), `console.log('quick'); process.exit(2);\n`);
    for (const t of [undefined, 0, -5]) {
      const r = runTestCommand('node q.mjs', dir, t);
      assert.equal(r.exitCode, 2);
      assert.match(r.stdout, /quick/);
      assert.notEqual(r.timedOut, true);
      assert.doesNotMatch(r.stderr, /timed out/);
    }
  });

  it('a never-ending command is stopped: 124, timedOut, stderr line, earlier output kept, returns quickly', { timeout: 60_000 }, () => {
    const dir = scratchDir();
    fs.writeFileSync(
      path.join(dir, 'forever.mjs'),
      `console.log('printed-before-timeout'); setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 10000);\n`,
    );
    const t0 = Date.now();
    const r = runTestCommand('node forever.mjs', dir, 1500);
    const elapsed = Date.now() - t0;

    assert.equal(r.exitCode, 124);
    assert.equal(r.timedOut, true);
    assert.ok(r.stderr.trimEnd().endsWith('[bastion] Command timed out after 1500ms.'), `stderr was: ${r.stderr}`);
    assert.match(r.stdout, /printed-before-timeout/);
    assert.ok(elapsed >= 1400, `returned too early: ${elapsed} ms`);
    assert.ok(elapsed < 8000, `took too long: ${elapsed} ms`);
    assert.ok(r.durationMs < 8000, `durationMs too long: ${r.durationMs}`);
  });

  it('the whole process tree is gone after a timeout (a never-ending grandchild is killed too)', { timeout: 60_000 }, () => {
    const dir = scratchDir();
    const pidFile = path.join(dir, 'child.pid');
    fs.writeFileSync(
      path.join(dir, 'child.mjs'),
      `import * as fs from 'node:fs';\n` +
        `fs.appendFileSync(${JSON.stringify(pidFile)}, process.pid + '\\n');\n` +
        `setInterval(() => {}, 1000);\nsetTimeout(() => process.exit(0), 10000);\n`,
    );
    fs.writeFileSync(
      path.join(dir, 'parent.mjs'),
      `import { spawn } from 'node:child_process';\n` +
        `console.log('parent-started');\n` +
        `const c = spawn(process.execPath, ['child.mjs'], { stdio: 'inherit' });\n` +
        `c.on('exit', (code) => process.exit(code ?? 0));\n` +
        `setTimeout(() => process.exit(0), 10000);\n`,
    );
    const t0 = Date.now();
    const r = runTestCommand('node parent.mjs', dir, 1500);
    const elapsed = Date.now() - t0;

    assert.equal(r.exitCode, 124);
    assert.equal(r.timedOut, true);
    assert.match(r.stdout, /parent-started/);
    assert.ok(elapsed < 8000, `took too long: ${elapsed} ms`);

    const pids = readPids(pidFile);
    assert.ok(pids.length >= 1, 'the child never recorded its pid, so the tree kill cannot be checked');
    const alive = stillAlive(pids);
    assert.deepEqual(alive, [], `child process(es) still running after the timeout: ${alive.join(',')}`);
  });
});

// A repo with a loop that one mutation (`finished = true` -> `false`) turns endless. The loop gives up after 8 s so an
// unfixed runner does not hang forever. Every process that runs the module records its pid in `pidFile`.
function loopSource(pidFile: string): string {
  return [
    `import * as fs from 'node:fs';`,
    `export function countTo(n) {`,
    `  fs.appendFileSync(${JSON.stringify(pidFile)}, process.pid + '\\n');`,
    `  const t0 = Date.now();`,
    `  let i = 0;`,
    `  let finished = 0;`,
    `  while (!finished) {`,
    `    i++;`,
    `    if (i >= n) { finished = true; }`,
    `    if (Date.now() - t0 > 8000) break;`,
    `  }`,
    `  if (i === 99) return -1;`,
    `  return i;`,
    `}`,
    ``,
  ].join('\n');
}

const LOOP_TEST = [
  `import test from 'node:test';`,
  `import assert from 'node:assert/strict';`,
  `import { countTo } from '../src/loop.mjs';`,
  `test('counts', () => { assert.equal(countTo(3), 3); });`,
  ``,
].join('\n');

function buildLoopRepo(pidFile: string, extraSource = ''): string {
  const repo = createTempGitRepo();
  captureSync(() => runInit({ cwd: repo, testCommand: 'node --test tests/loop.test.mjs', baseBranch: 'main' }));
  writeRepoFile(repo, 'src/loop.mjs', loopSource(pidFile) + extraSource);
  writeRepoFile(repo, 'tests/loop.test.mjs', LOOP_TEST);
  git(['add', '.'], repo);
  git(['commit', '-m', 'feat: loop'], repo);
  return repo;
}

describe('v1.1 runMutate timeout', { timeout: 60_000 }, () => {
  it('a mutant that never ends is killed by timeout, the rest still run, file restored, exit 0', { timeout: 60_000 }, () => {
    const pidFile = path.join(scratchDir(), 'pids.txt');
    const repo = buildLoopRepo(pidFile);
    const original = fs.readFileSync(path.join(repo, 'src/loop.mjs'));

    const t0 = Date.now();
    const { result, out, err } = captureSync(() =>
      runMutate({ cwd: repo, files: ['src/loop.mjs'], maxMutations: 10, timeoutMs: 2000 }),
    );
    const elapsed = Date.now() - t0;
    const all = `${out}\n${err}`;

    assert.equal(result, 0, `output:\n${all}`);
    const killedLines = out.split('\n').filter((l) => l.includes('[KILLED]'));
    const timeoutLines = killedLines.filter((l) => l.trimEnd().endsWith('[timeout]'));
    assert.equal(timeoutLines.length, 1, `output:\n${all}`);
    assert.match(timeoutLines[0], /^ {2}\[KILLED\] {3}src\/loop\.mjs:\d+ \(true -> false\) \[timeout\]$/);
    // the other two mutants are ordinary kills and were still checked after the hanging one
    assert.equal(killedLines.length, 3, `output:\n${all}`);
    assert.match(out, /\[bastion\] Mutation score: 3\/3 killed \(1 by timeout\)\./);
    assert.ok(elapsed < 40_000, `took too long: ${elapsed} ms`);

    assert.ok(original.equals(fs.readFileSync(path.join(repo, 'src/loop.mjs'))), 'source file changed');
    assert.equal(git(['status', '--porcelain'], repo), '');

    // nothing keeps running after runMutate returned
    const alive = stillAlive(readPids(pidFile));
    assert.deepEqual(alive, [], `test process(es) still running: ${alive.join(',')}`);
  });

  it('works in place (dirty tree) too: restores the file, counts a survivor, returns 1', { timeout: 60_000 }, () => {
    const pidFile = path.join(scratchDir(), 'pids.txt');
    const repo = buildLoopRepo(pidFile, `export function unused(x) {\n  return x === 42;\n}\n`);
    writeRepoFile(repo, 'notes.txt', 'untracked file makes the tree dirty\n'); // no isolated worktree
    const original = fs.readFileSync(path.join(repo, 'src/loop.mjs'));

    const { result, out, err } = captureSync(() =>
      runMutate({ cwd: repo, files: ['src/loop.mjs'], maxMutations: 10, timeoutMs: 2000 }),
    );
    const all = `${out}\n${err}`;

    assert.equal(result, 1, `output:\n${all}`);
    assert.equal(out.split('\n').filter((l) => /\[KILLED\].*\[timeout\]$/.test(l.trimEnd())).length, 1, `output:\n${all}`);
    assert.match(err, /\[SURVIVED\].*src\/loop\.mjs:\d+/);
    assert.match(out, /\[bastion\] Mutation score: 3\/4 killed \(1 by timeout\)\./);
    assert.ok(original.equals(fs.readFileSync(path.join(repo, 'src/loop.mjs'))), 'source file changed');

    const alive = stillAlive(readPids(pidFile));
    assert.deepEqual(alive, [], `test process(es) still running: ${alive.join(',')}`);
  });

  it('without a timing-out mutant the summary line is the old one, with no parenthesis', { timeout: 60_000 }, () => {
    const repo = createTempGitRepo();
    captureSync(() => runInit({ cwd: repo, testCommand: 'node --test tests/guard.test.mjs', baseBranch: 'main' }));
    writeRepoFile(repo, 'src/guard.mjs', 'export function isAdult(age) {\n  return age >= 18;\n}\n');
    writeRepoFile(
      repo,
      'tests/guard.test.mjs',
      `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { isAdult } from '../src/guard.mjs';\ntest('adult', () => { assert.equal(isAdult(20), true); });\n`,
    );
    git(['add', '.'], repo);
    git(['commit', '-m', 'feat: guard'], repo);

    const { result, out } = captureSync(() =>
      runMutate({ cwd: repo, files: ['src/guard.mjs'], maxMutations: 3, timeoutMs: 20_000 }),
    );
    assert.equal(result, 0);
    assert.match(out, /^\[bastion\] Mutation score: 1\/1 killed\.$/m);
    assert.doesNotMatch(out, /by timeout/);
    assert.doesNotMatch(out, /\[timeout\]/);
  });
});
