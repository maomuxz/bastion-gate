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
import { runPlan } from '../src/commands/plan.js';
import { runSwarm } from '../src/commands/run.js';

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
    const gitignore = fs.readFileSync(path.join(repo, '.gitignore'), 'utf8');
    assert.ok(gitignore.includes('.bastion/worktrees/'));
    assert.ok(gitignore.includes('.bastion/logs/'));
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

  it('plan & run orchestrate parallel worktree waves, block test-cheat with retry, and verify merged result', async () => {
    const repo = createTempGitRepo();
    runInit({ cwd: repo, testCommand: 'node --test tests/*.test.mjs', baseBranch: 'main' });

    writeRepoFile(repo, 'src/a.mjs', 'export function getA() { return 0; }\n');
    writeRepoFile(repo, 'src/b.mjs', 'export function getB() { return 0; }\n');
    writeRepoFile(repo, 'src/c.mjs', 'export function getC() { return 0; }\n');
    writeRepoFile(
      repo,
      'tests/a.test.mjs',
      `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { getA } from '../src/a.mjs';\ntest('a returns 10', () => { assert.equal(getA(), 10); });\n`
    );
    writeRepoFile(
      repo,
      'tests/b.test.mjs',
      `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { getB } from '../src/b.mjs';\ntest('b returns 20', () => { assert.equal(getB(), 20); });\n`
    );
    writeRepoFile(
      repo,
      'tests/c.test.mjs',
      `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { getC } from '../src/c.mjs';\ntest('c sums a and b', () => { assert.equal(getC(), 30); });\n`
    );

    // Mock harness-agnostic agent script: node-a cheats on attempt 1, verifies feedback + promptFile on attempt 2
    writeRepoFile(
      repo,
      'scripts/mock-agent.mjs',
      [
        `import * as fs from 'node:fs';`,
        `import { execFileSync } from 'node:child_process';`,
        `const id = process.env.BASTION_NODE_ID;`,
        `const attempt = Number(process.env.BASTION_ATTEMPT);`,
        `const promptFile = process.env.BASTION_PROMPT_FILE;`,
        `if (!promptFile || !fs.existsSync(promptFile)) throw new Error('missing promptFile');`,
        `if (id === 'node-a') {`,
        `  if (attempt === 1) {`,
        `    fs.writeFileSync('tests/a.test.mjs', 'import test from "node:test"; test("hack", () => {});\\n');`,
        `  } else {`,
        `    const fb = process.env.BASTION_FEEDBACK || '';`,
        `    if (!fb.includes('tests/a.test.mjs')) throw new Error('missing detailed gate violation feedback');`,
        `    execFileSync('git', ['checkout', '--', 'tests/a.test.mjs']);`,
        `    fs.writeFileSync('src/a.mjs', 'export function getA() { return 10; }\\n');`,
        `  }`,
        `} else if (id === 'node-b') {`,
        `  fs.writeFileSync('src/b.mjs', 'export function getB() { return 20; }\\n');`,
        `} else if (id === 'node-c') {`,
        `  fs.writeFileSync('src/c.mjs', "import { getA } from './a.mjs'; import { getB } from './b.mjs'; export function getC() { return getA() + getB(); }\\n");`,
        `}`,
      ].join('\n') + '\n'
    );

    writeRepoFile(
      repo,
      '.bastion/plan.json',
      JSON.stringify(
        {
          version: 1,
          nodes: [
            { id: 'node-a', title: 'Implement A', prompt: 'Implement A', testCommand: 'node --test tests/a.test.mjs', tier: 1 },
            { id: 'node-b', title: 'Implement B', prompt: 'Implement B', testCommand: 'node --test tests/b.test.mjs', tier: 1 },
            { id: 'node-c', title: 'Integrate C', dependsOn: ['node-a', 'node-b'], prompt: 'Integrate C', testCommand: 'node --test tests/c.test.mjs', tier: 1 },
          ],
        },
        null,
        2
      )
    );

    git(['add', '.'], repo);
    git(['commit', '-m', 'chore: setup parallel swarm baseline'], repo);

    assert.equal(runLock({ cwd: repo }), 0);
    git(['add', '.bastion/lock.json'], repo);
    git(['commit', '-m', 'chore: lock baseline tests'], repo);

    assert.equal(runPlan({ cwd: repo }), 0);

    const swarmCode = await runSwarm({
      cwd: repo,
      baseRef: 'main',
      agentCommand: 'node scripts/mock-agent.mjs',
      concurrency: 2,
      maxRetries: 2,
      verifyRuns: 2,
    });
    assert.equal(swarmCode, 0);
    assert.equal(runAudit({ cwd: repo }), 0);

    // Verify runSwarm created an integration branch and left main untouched
    const currentBranch = git(['rev-parse', '--abbrev-ref', 'HEAD'], repo);
    assert.ok(currentBranch.startsWith('bastion/run-'));
    assert.ok(fs.existsSync(path.join(repo, '.bastion', 'logs', 'node-a-attempt-1.log')));
  });

  it('plan --init generates nodes from locked test files and run aborts fast on setupCommand failure', async () => {
    const repo = createTempGitRepo();
    runInit({ cwd: repo, testCommand: 'node --test tests/test_py_style.mjs', baseBranch: 'main' });
    writeRepoFile(repo, 'tests/test_py_style.mjs', 'import test from "node:test"; import assert from "node:assert/strict"; test("fail", () => { assert.equal(1, 2); });\n');
    git(['add', '.'], repo);
    git(['commit', '-m', 'test: py style'], repo);
    assert.equal(runLock({ cwd: repo }), 0);
    assert.equal(runPlan({ cwd: repo, init: true }), 0);

    const plan = JSON.parse(fs.readFileSync(path.join(repo, '.bastion', 'plan.json'), 'utf8'));
    assert.equal(plan.nodes.length, 1);
    assert.equal(plan.nodes[0].id, 'test_py_style');

    git(['add', '.'], repo);
    git(['commit', '-m', 'chore: lock and plan'], repo);

    // Failing setupCommand must abort immediately without running agent
    const failCode = await runSwarm({
      cwd: repo,
      baseRef: 'main',
      setupCommand: 'node -e "process.exit(1)"',
      agentCommand: 'node -e "throw new Error(\'should not run\')"',
    });
    assert.equal(failCode, 1);
  });
});
