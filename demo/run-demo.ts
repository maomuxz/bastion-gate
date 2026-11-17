import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runGate } from '../src/commands/gate.js';
import { runInit } from '../src/commands/init.js';
import { runLock } from '../src/commands/lock.js';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function write(repo: string, rel: string, content: string): void {
  const full = path.join(repo, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}

function banner(title: string): void {
  console.log('\n' + '='.repeat(64));
  console.log(title);
  console.log('='.repeat(64));
}

function main(): void {
  const demoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bastion-demo-'));
  try {
    git(['init', '-b', 'main'], demoRoot);
    git(['config', 'user.email', 'demo@bastion.local'], demoRoot);
    git(['config', 'user.name', 'Bastion Demo'], demoRoot);

    runInit({
      cwd: demoRoot,
      testCommand: 'node --test tests/discount.test.mjs',
      baseBranch: 'main',
    });

    // Scenario 1: AI writes a tautological green test -> rejected by lock
    banner('SCENARIO 1: AI writes a tautological test -> bastion lock REJECTS');
    write(demoRoot, 'src/discount.mjs', 'export function applyDiscount(price) { return price; }\n');
    write(
      demoRoot,
      'tests/discount.test.mjs',
      `import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('applies 20% discount', () => {\n  assert.equal(true, true); // tautological test\n});\n`
    );
    git(['add', '.'], demoRoot);
    git(['commit', '-m', 'test: tautological discount test'], demoRoot);

    const s1Code = runLock({ cwd: demoRoot });
    console.log(`-> bastion lock exited with: ${s1Code} (expected 1)`);

    // Scenario 2: Replace with a real failing test -> lock -> AI cheats -> gate blocks -> real fix -> gate passes
    banner('SCENARIO 2: Real red test -> lock -> AI edits test -> gate BLOCKS');
    write(
      demoRoot,
      'tests/discount.test.mjs',
      `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { applyDiscount } from '../src/discount.mjs';\ntest('applies 20% discount', () => {\n  assert.equal(applyDiscount(100, 0.2), 80);\n});\n`
    );
    git(['add', 'tests/discount.test.mjs'], demoRoot);
    git(['commit', '-m', 'test: real failing acceptance test'], demoRoot);

    const lockOk = runLock({ cwd: demoRoot });
    console.log(`-> bastion lock exited with: ${lockOk} (expected 0)`);
    git(['add', '.bastion/lock.json'], demoRoot);
    git(['commit', '-m', 'chore: lock baseline tests'], demoRoot);

    git(['checkout', '-b', 'agent/work'], demoRoot);
    console.log('\n[Agent] Weakening tests/discount.test.mjs instead of fixing code...');
    write(
      demoRoot,
      'tests/discount.test.mjs',
      `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { applyDiscount } from '../src/discount.mjs';\ntest('applies 20% discount', () => {\n  assert.equal(applyDiscount(100, 0.2), 100);\n});\n`
    );
    git(['add', 'tests/discount.test.mjs'], demoRoot);
    git(['commit', '-m', 'agent: make test pass by changing assertion'], demoRoot);

    const cheatGate = runGate({ cwd: demoRoot, baseRef: 'main' });
    console.log(`-> bastion gate exited with: ${cheatGate} (expected 1)`);

    banner('SCENARIO 3: Revert test cheat & implement real fix -> gate PASSES');
    git(['checkout', 'main', '--', 'tests/discount.test.mjs'], demoRoot);
    write(
      demoRoot,
      'src/discount.mjs',
      'export function applyDiscount(price, rate) { return price * (1 - rate); }\n'
    );
    git(['add', '.'], demoRoot);
    git(['commit', '-m', 'feat: implement applyDiscount'], demoRoot);

    const realGate = runGate({ cwd: demoRoot, baseRef: 'main' });
    console.log(`-> bastion gate exited with: ${realGate} (expected 0)`);
  } finally {
    fs.rmSync(demoRoot, { recursive: true, force: true });
  }
}

main();
