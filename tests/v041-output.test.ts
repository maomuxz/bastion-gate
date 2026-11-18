// M2 (F4/F7) - quieter gate: drop stack frames, keep assertions, cap lines.
import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'node:test';
import { runGateAsync } from '../src/commands/gate.js';
import { runInit } from '../src/commands/init.js';
import { runLock } from '../src/commands/lock.js';
import { summarizeTestOutput } from '../src/output.js';
import { captureConsole, cleanupTempRepos, createTempGitRepo, git, writeRepoFile } from './v04-helpers.js';

afterEach(cleanupTempRepos);

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const NL = '\n';

const SAMPLE = [
  '✖ adds (1.2ms)',
  '  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:',
  '  0 !== 5',
  '      at TestContext.<anonymous> (file:///C:/repo/tests/calc.test.mjs:4:40)',
  '      at Test.runInAsyncScope (node:async_hooks:227:14)',
  '      at node:internal/test_runner/test:1402:25',
  '      at async Promise.all (index 0)',
  '      at async startSubtestAfterBootstrap (node:internal/test_runner/harness:387:3) {',
  '  at least one test failed',
  'ℹ fail 1',
].join('\r' + NL);

function noisyRepo(passing: boolean): string {
  const repo = createTempGitRepo();
  runInit({ cwd: repo, testCommand: 'node --test tests/noisy.test.mjs', baseBranch: 'main' });
  writeRepoFile(repo, 'src/val.mjs', 'export const val = 0;' + NL);
  writeRepoFile(
    repo,
    'tests/noisy.test.mjs',
    [
      `import test from 'node:test';`,
      `import assert from 'node:assert/strict';`,
      `import { val } from '../src/val.mjs';`,
      `for (let i = 0; i < 200; i++) console.log('noise-' + i);`,
      `test('val is 1', () => { assert.equal(val, 1); });`,
    ].join(NL) + NL
  );
  git(['add', '.'], repo);
  git(['commit', '-m', 'baseline'], repo);
  assert.equal(runLock({ cwd: repo }), 0);
  git(['add', '.bastion/lock.json'], repo);
  git(['commit', '-m', 'lock'], repo);
  if (passing) {
    writeRepoFile(repo, 'src/val.mjs', 'export const val = 1;' + NL);
    git(['commit', '-am', 'fix'], repo);
  }
  return repo;
}

describe('v0.4.1 M2 output', () => {
  it('drops stack frames but keeps assertion and summary lines in order', () => {
    const out = summarizeTestOutput(SAMPLE, 40);
    const expected = [
      '✖ adds (1.2ms)',
      '  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:',
      '  0 !== 5',
      '  at least one test failed',
      'ℹ fail 1',
    ].join(NL);
    assert.equal(out, expected);
  });

  it('keeps only the last maxLines lines and has no trailing newline', () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join(NL) + NL;
    const out = summarizeTestOutput(text, 10);
    const lines = out.split(NL);
    assert.equal(lines.length, 10);
    assert.equal(lines[0], 'line 91');
    assert.equal(lines[9], 'line 100');
    assert.ok(!out.endsWith(NL));
  });

  it('gate PASS prints a short summary instead of the full noisy output', () => {
    const repo = noisyRepo(true);
    const res = spawnSync(process.execPath, [CLI, 'gate', '--base', 'main'], { cwd: repo, encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    const text = res.stdout + NL + res.stderr;
    const noise = text.split(/\r?\n/).filter((l) => /noise-\d+/.test(l)).length;
    assert.ok(noise <= 20, `printed ${noise} noise lines`);
  });

  it('gate FAIL feedback for the agent has no stack frames and still shows the assertion', async () => {
    const repo = noisyRepo(false);
    git(['checkout', '-b', 'feat/x'], repo);
    const { result } = await captureConsole(() => runGateAsync({ cwd: repo, baseRef: 'main' }));
    assert.equal(result.exitCode, 1);
    assert.ok(!/^\s*at\s.+:\d+:\d+\)?\s*$/m.test(result.feedback), 'no stack frames in feedback');
    assert.match(result.feedback, /AssertionError|!==/);
    assert.ok(result.feedback.split(NL).length <= 41);
  });
});
