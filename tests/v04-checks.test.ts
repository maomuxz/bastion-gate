// N2 - gate pre-checks: run in order from the baseline config, stop at the first failure, name it.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { runPreChecks, runPreChecksAsync } from '../src/checks.js';
import { runGate } from '../src/commands/gate.js';
import { runInit } from '../src/commands/init.js';
import { runLock } from '../src/commands/lock.js';
import { captureConsole, cleanupTempRepos, createTempGitRepo, git, readJson, writeRepoFile } from './v04-helpers.js';

afterEach(cleanupTempRepos);

function checkScripts(dir: string): void {
  writeRepoFile(dir, 'ok.mjs', 'process.exit(0);\n');
  writeRepoFile(dir, 'boom.mjs', 'console.error("LINT-BOOM: 3 problems"); process.exit(2);\n');
  writeRepoFile(dir, 'mark.mjs', 'import fs from "node:fs"; fs.writeFileSync("marked.txt", "x");\n');
}

describe('v0.4 N2 checks', () => {
  it('runPreChecks passes when every check exits 0', () => {
    const dir = createTempGitRepo();
    checkScripts(dir);
    const res = runPreChecks(['node ok.mjs', 'node mark.mjs'], dir);
    assert.equal(res.ok, true);
    assert.equal(res.feedback, '');
    assert.ok(fs.existsSync(path.join(dir, 'marked.txt')), 'checks run in cwd, in order');
  });

  it('runPreChecks stops at the first failure and reports which check and its output', () => {
    const dir = createTempGitRepo();
    checkScripts(dir);
    const res = runPreChecks(['node ok.mjs', 'node boom.mjs', 'node mark.mjs'], dir);
    assert.equal(res.ok, false);
    assert.equal(res.failedCommand, 'node boom.mjs');
    assert.match(res.feedback, /node boom\.mjs/);
    assert.match(res.feedback, /LINT-BOOM/);
    assert.equal(fs.existsSync(path.join(dir, 'marked.txt')), false, 'checks after the failing one must not run');
  });

  it('runPreChecksAsync has the same contract', async () => {
    const dir = createTempGitRepo();
    checkScripts(dir);
    const bad = await runPreChecksAsync(['node ok.mjs', 'node boom.mjs', 'node mark.mjs'], dir);
    assert.equal(bad.ok, false);
    assert.equal(bad.failedCommand, 'node boom.mjs');
    assert.match(bad.feedback, /LINT-BOOM/);
    assert.equal(fs.existsSync(path.join(dir, 'marked.txt')), false);
    const good = await runPreChecksAsync(['node ok.mjs'], dir);
    assert.deepEqual(good, { ok: true, feedback: '' });
  });

  it('an empty check list passes', () => {
    const dir = createTempGitRepo();
    assert.equal(runPreChecks([], dir).ok, true);
  });

  it('gate runs baseline checks before the tests and fails naming the check', async () => {
    const repo = createTempGitRepo();
    runInit({ cwd: repo, testCommand: 'node --test tests/calc.test.mjs', baseBranch: 'main' });
    const cfgPath = path.join(repo, '.bastion', 'config.json');
    const cfg = readJson<Record<string, unknown>>(cfgPath);
    fs.writeFileSync(cfgPath, JSON.stringify({ ...cfg, checks: ['node scripts/no-todo.mjs'] }, null, 2) + '\n');
    // the check fails if any source file contains the word HACK
    writeRepoFile(
      repo,
      'scripts/no-todo.mjs',
      'import fs from "node:fs"; const s = fs.readFileSync("src/calc.mjs", "utf8"); if (s.includes("HACK")) { console.error("found HACK in src/calc.mjs"); process.exit(1); }\n'
    );
    writeRepoFile(repo, 'src/calc.mjs', 'export function add() { return 0; }\n');
    writeRepoFile(
      repo,
      'tests/calc.test.mjs',
      `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/calc.mjs';\ntest('adds', () => { assert.equal(add(2, 3), 5); });\n`
    );
    git(['add', '.'], repo);
    git(['commit', '-m', 'baseline'], repo);
    assert.equal(runLock({ cwd: repo }), 0);
    git(['add', '.bastion/lock.json'], repo);
    git(['commit', '-m', 'lock'], repo);

    git(['checkout', '-b', 'feat/hacky'], repo);
    writeRepoFile(repo, 'src/calc.mjs', 'export function add(a, b) { return a + b; } // HACK\n');
    git(['commit', '-am', 'hacky but green'], repo);
    const hacky = await captureConsole(() => runGate({ cwd: repo, baseRef: 'main' }));
    assert.equal(hacky.result, 1, 'tests pass but the pre-check must fail the gate');
    assert.match(hacky.err, /no-todo\.mjs/);

    git(['checkout', 'main'], repo);
    git(['checkout', '-b', 'feat/clean'], repo);
    writeRepoFile(repo, 'src/calc.mjs', 'export function add(a, b) { return a + b; }\n');
    git(['commit', '-am', 'clean fix'], repo);
    const clean = await captureConsole(() => runGate({ cwd: repo, baseRef: 'main' }));
    assert.equal(clean.result, 0);
  });

  it('runtime artifacts under .bastion/outbox/ are not treated as tampering', async () => {
    const repo = createTempGitRepo();
    runInit({ cwd: repo, testCommand: 'node --test tests/calc.test.mjs', baseBranch: 'main' });
    writeRepoFile(repo, 'src/calc.mjs', 'export function add() { return 0; }\n');
    writeRepoFile(
      repo,
      'tests/calc.test.mjs',
      `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/calc.mjs';\ntest('adds', () => { assert.equal(add(2, 3), 5); });\n`
    );
    git(['add', '.'], repo);
    git(['commit', '-m', 'baseline'], repo);
    assert.equal(runLock({ cwd: repo }), 0);
    git(['add', '.bastion/lock.json'], repo);
    git(['commit', '-m', 'lock'], repo);

    git(['checkout', '-b', 'feat/fix'], repo);
    writeRepoFile(repo, 'src/calc.mjs', 'export function add(a, b) { return a + b; }\n');
    git(['commit', '-am', 'fix'], repo);
    writeRepoFile(repo, '.bastion/outbox/n1.decisions.json', '[{"title":"t","chosen":"c","why":"w"}]\n');
    writeRepoFile(repo, '.bastion/outbox/n1.tier3.json', '[{"question":"q"}]\n');
    const res = await captureConsole(() => runGate({ cwd: repo, baseRef: 'main' }));
    assert.equal(res.result, 0);
  });
});
