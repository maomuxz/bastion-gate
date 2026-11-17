import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { runAudit } from '../src/commands/audit.js';
import { runGate } from '../src/commands/gate.js';
import { runInit } from '../src/commands/init.js';
import { runLock } from '../src/commands/lock.js';
import { runMutate } from '../src/commands/mutate.js';

const tempDirs: string[] = [];

function createTempGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bastion-test-'));
  tempDirs.push(dir);
  git(['init', '-b', 'main'], dir);
  git(['config', 'user.email', 'test@bastion.local'], dir);
  git(['config', 'user.name', 'Bastion Test'], dir);
  return dir;
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function writeRepoFile(repoDir: string, rel: string, content: string): void {
  const full = path.join(repoDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('bastion-gate v0.1 e2e', () => {
  it('init generates config, AGENTS.md, SKILL.md, and GitHub Action workflow', () => {
    const repo = createTempGitRepo();
    const code = runInit({
      cwd: repo,
      testCommand: 'node --test tests/app.test.mjs',
      baseBranch: 'main',
    });
    assert.equal(code, 0);
    assert.ok(fs.existsSync(path.join(repo, '.bastion', 'config.json')));
    assert.ok(fs.existsSync(path.join(repo, 'AGENTS.md')));
    assert.ok(fs.existsSync(path.join(repo, '.agents', 'skills', 'bastion-gate', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(repo, '.github', 'workflows', 'bastion.yml')));
  });

  it('lock rejects tautological green tests on baseline (red-first enforcement)', () => {
    const repo = createTempGitRepo();
    runInit({ cwd: repo, testCommand: 'node --test tests/app.test.mjs', baseBranch: 'main' });
    writeRepoFile(
      repo,
      'tests/app.test.mjs',
      `import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('always passes', () => { assert.equal(1, 1); });\n`
    );
    git(['add', '.'], repo);
    git(['commit', '-m', 'chore: add tautological test'], repo);

    const lockCode = runLock({ cwd: repo });
    assert.equal(lockCode, 1);
    assert.equal(fs.existsSync(path.join(repo, '.bastion', 'lock.json')), false);
  });

  it('locks red test, blocks test/config tampering in gate, and passes genuine fix', () => {
    const repo = createTempGitRepo();
    runInit({ cwd: repo, testCommand: 'node --test tests/calc.test.mjs', baseBranch: 'main' });
    writeRepoFile(repo, 'src/calc.mjs', 'export function add(a, b) { return 0; }\n');
    writeRepoFile(
      repo,
      'tests/calc.test.mjs',
      `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/calc.mjs';\ntest('adds two numbers', () => { assert.equal(add(2, 3), 5); });\n`
    );
    git(['add', '.'], repo);
    git(['commit', '-m', 'test: add failing acceptance test'], repo);

    // 1. Lock succeeds because test is RED
    assert.equal(runLock({ cwd: repo }), 0);
    const lockJson = JSON.parse(fs.readFileSync(path.join(repo, '.bastion', 'lock.json'), 'utf8'));
    assert.deepEqual(lockJson.testSummary, [{ file: 'tests/calc.test.mjs', names: ['adds two numbers'] }]);
    git(['add', '.bastion/lock.json'], repo);
    git(['commit', '-m', 'chore: lock baseline tests'], repo);

    // 2. Branch off main: AI tries to cheat by editing the test
    git(['checkout', '-b', 'feat/ai-cheat'], repo);
    writeRepoFile(
      repo,
      'tests/calc.test.mjs',
      `import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('adds two numbers', () => { assert.equal(0, 0); });\n`
    );
    git(['add', 'tests/calc.test.mjs'], repo);
    git(['commit', '-m', 'cheat: weaken test'], repo);
    assert.equal(runGate({ cwd: repo, baseRef: 'main' }), 1);

    // 3. AI tries to cheat by changing .bastion/config.json testCommand to exit 0
    git(['checkout', 'main'], repo);
    git(['checkout', '-b', 'feat/config-cheat'], repo);
    const cfg = JSON.parse(fs.readFileSync(path.join(repo, '.bastion', 'config.json'), 'utf8'));
    cfg.testCommand = 'node -e "process.exit(0)"';
    writeRepoFile(repo, '.bastion/config.json', JSON.stringify(cfg, null, 2));
    git(['add', '.bastion/config.json'], repo);
    git(['commit', '-m', 'cheat: weaken testCommand'], repo);
    assert.equal(runGate({ cwd: repo, baseRef: 'main' }), 1);

    // 4. Genuine implementation passes gate
    git(['checkout', 'main'], repo);
    git(['checkout', '-b', 'feat/real-fix'], repo);
    writeRepoFile(repo, 'src/calc.mjs', 'export function add(a, b) { return a + b; }\n');
    git(['add', 'src/calc.mjs'], repo);
    git(['commit', '-m', 'feat: implement add'], repo);
    assert.equal(runGate({ cwd: repo, baseRef: 'main' }), 0);

    // 5. Merge clean fix -> audit passes
    git(['checkout', 'main'], repo);
    git(['merge', '--no-ff', 'feat/real-fix', '-m', 'Merge feat/real-fix'], repo);
    assert.equal(runAudit({ cwd: repo }), 0);

    // 6. Force-merge cheating branch -> audit catches bypass
    git(['merge', '--no-ff', 'feat/ai-cheat', '-m', 'Merge feat/ai-cheat'], repo);
    assert.equal(runAudit({ cwd: repo }), 1);
  });

  it('init auto-detects testCommand for Python, Go, Rust, and Flutter projects', () => {
    const cases: Array<[string, string]> = [
      ['pyproject.toml', 'pytest'],
      ['go.mod', 'go test ./...'],
      ['Cargo.toml', 'cargo test'],
      ['pubspec.yaml', 'flutter test'],
    ];

    for (const [markerFile, expectedCmd] of cases) {
      const repo = createTempGitRepo();
      writeRepoFile(repo, markerFile, '# marker\n');
      assert.equal(runInit({ cwd: repo }), 0);
      const cfg = JSON.parse(fs.readFileSync(path.join(repo, '.bastion', 'config.json'), 'utf8'));
      assert.equal(cfg.testCommand, expectedCmd, `Expected ${markerFile} -> ${expectedCmd}`);
    }
  });

  it('lock ignores gitignored build/output directories like dist-test', () => {
    const repo = createTempGitRepo();
    runInit({ cwd: repo, testCommand: 'node --test tests/app.test.mjs', baseBranch: 'main' });
    writeRepoFile(repo, '.gitignore', 'dist-test/\n');
    writeRepoFile(repo, 'dist-test/tests/app.test.mjs', 'test("ignored", () => {});\n');
    writeRepoFile(
      repo,
      'tests/app.test.mjs',
      `import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('real failing test', () => { assert.equal(1, 2); });\n`
    );
    git(['add', '.'], repo);
    git(['commit', '-m', 'test: add gitignore and failing test'], repo);

    assert.equal(runLock({ cwd: repo }), 0);
    const lockJson = JSON.parse(fs.readFileSync(path.join(repo, '.bastion', 'lock.json'), 'utf8'));
    const lockedPaths = lockJson.lockedFiles.map((f: { path: string }) => f.path);
    assert.ok(lockedPaths.includes('tests/app.test.mjs'));
    assert.equal(lockedPaths.includes('dist-test/tests/app.test.mjs'), false);
  });

  it('mutate detects killed vs survived mutations and always restores source files', () => {
    const repo = createTempGitRepo();
    runInit({ cwd: repo, testCommand: 'node --test tests/guard.test.mjs', baseBranch: 'main' });
    writeRepoFile(
      repo,
      'src/guard.mjs',
      'export function isAdult(age) {\n  return age >= 18;\n}\n'
    );
    writeRepoFile(
      repo,
      'tests/guard.test.mjs',
      `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { isAdult } from '../src/guard.mjs';\ntest('adult check', () => { assert.equal(isAdult(20), true); });\n`
    );
    git(['add', '.'], repo);
    git(['commit', '-m', 'feat: initial guard'], repo);

    // Run mutation spot-check on src/guard.mjs (>= -> < should fail test -> killed!)
    const originalSrc = fs.readFileSync(path.join(repo, 'src/guard.mjs'), 'utf8');
    const killedCode = runMutate({ cwd: repo, files: ['src/guard.mjs'], maxMutations: 3 });
    assert.equal(killedCode, 0);
    assert.equal(fs.readFileSync(path.join(repo, 'src/guard.mjs'), 'utf8'), originalSrc);

    // Add an untested branch: a survived mutation must make mutate return 1 and still restore file
    writeRepoFile(
      repo,
      'src/guard.mjs',
      'export function isAdult(age) {\n  return age >= 18;\n}\nexport function unusedCheck(x) {\n  return x === 42;\n}\n'
    );
    const originalWithUnused = fs.readFileSync(path.join(repo, 'src/guard.mjs'), 'utf8');
    const survivedCode = runMutate({ cwd: repo, files: ['src/guard.mjs'], maxMutations: 5 });
    assert.equal(survivedCode, 1);
    assert.equal(fs.readFileSync(path.join(repo, 'src/guard.mjs'), 'utf8'), originalWithUnused);
  });
});
