import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCheck } from '../src/commands/check.js';
import { runGate } from '../src/commands/gate.js';
import { runInit } from '../src/commands/init.js';
import { runLock } from '../src/commands/lock.js';
import { runSheet } from '../src/commands/sheet.js';

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

async function main(): Promise<void> {
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
    assert.equal(s1Code, 1);

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
    assert.equal(lockOk, 0);
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
    assert.equal(cheatGate, 1);

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
    assert.equal(realGate, 0);

    // Scenario 4: bastion sheet extracts a compact Dart API cheatsheet (pure text parsing, no Dart SDK needed)
    banner('SCENARIO 4: bastion sheet extracts a Dart public API cheatsheet');
    const sheetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bastion-demo-sheet-'));
    try {
      write(sheetDir, 'pubspec.yaml', 'name: acme_ui\nversion: 0.1.0\n');
      write(
        sheetDir,
        'checks/style_rules.dart',
        [
          '// 1. Color literals may only live inside lib/ui/tokens/.',
          '// 2. Outside lib/ui/, use unified Acme widgets instead of raw framework dialogs.',
          'void main() {}',
          '',
        ].join('\n')
      );
      write(
        sheetDir,
        'lib/ui/tokens/tokens.dart',
        [
          'class AcmeTokens extends ThemeExtension<AcmeTokens> {',
          '  const AcmeTokens({required this.primary, required this.surface, required this.ink});',
          '  final Color primary;',
          '  final Color surface;',
          '  final Color ink;',
          '  static AcmeTokens of(BuildContext context) => throw UnimplementedError();',
          '}',
          '',
        ].join('\n')
      );
      write(
        sheetDir,
        'lib/ui/base/button.dart',
        [
          'enum AcmeButtonKind { primary, secondary, danger }',
          'class AcmeButton extends StatelessWidget {',
          '  const AcmeButton({super.key, required this.label, this.kind = AcmeButtonKind.secondary, this.onPressed});',
          '  final String label;',
          '  final AcmeButtonKind kind;',
          '  final VoidCallback? onPressed;',
          '}',
          '',
        ].join('\n')
      );
      write(
        sheetDir,
        'lib/ui/shell/toast.dart',
        [
          'abstract final class AcmeToast {',
          '  static void show(BuildContext context, String message, {int durationMs = 2500}) {}',
          '}',
          '',
        ].join('\n')
      );
      write(
        sheetDir,
        'lib/ui/ui.dart',
        "export 'tokens/tokens.dart';\nexport 'base/button.dart';\nexport 'shell/toast.dart';\n"
      );
      write(
        sheetDir,
        '.bastion/sheet.json',
        JSON.stringify(
          {
            language: 'dart',
            output: '.bastion/sheet.md',
            title: 'Acme UI Cheatsheet',
            ruleFiles: ['checks/style_rules.dart'],
            entries: [
              {
                path: 'lib/ui/ui.dart',
                title: "Unified Widgets (`import 'package:acme_ui/ui/ui.dart';`)",
              },
            ],
          },
          null,
          2
        ) + '\n'
      );

      const sheetExit = runSheet({ cwd: sheetDir });
      console.log(`-> bastion sheet exited with: ${sheetExit} (expected 0)\n`);
      assert.equal(sheetExit, 0);
      console.log(fs.readFileSync(path.join(sheetDir, '.bastion/sheet.md'), 'utf8').trimEnd());
    } finally {
      fs.rmSync(sheetDir, { recursive: true, force: true });
    }

    // Scenario 5: bastion check (Node syntax check + locked rule script -> bare report -> tamper blocked -> clean pass)
    banner('SCENARIO 5: bastion check (violation -> tamper blocked -> clean pass)');
    const checkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bastion-demo-check-'));
    try {
      git(['init', '-b', 'main'], checkDir);
      git(['config', 'user.email', 'demo@bastion.local'], checkDir);
      git(['config', 'user.name', 'Bastion Demo'], checkDir);

      write(
        checkDir,
        'checks/no-eval.mjs',
        [
          "import * as fs from 'node:fs';",
          "const files = process.argv.slice(2).filter((f) => f !== '.' && fs.existsSync(f));",
          'let bad = 0;',
          'for (const f of files) {',
          "  const lines = fs.readFileSync(f, 'utf8').split(/\\r?\\n/);",
          '  lines.forEach((line, i) => {',
          "    if (/\\beval\\s*\\(/.test(line)) {",
          "      console.error(`${f}:${i + 1}  Dynamic eval() is forbidden. Try using JSON.parse instead.`);",
          '      bad++;',
          '    }',
          '  });',
          '}',
          'process.exit(bad > 0 ? 1 : 0);',
          '',
        ].join('\n')
      );
      write(
        checkDir,
        '.bastion/check.json',
        JSON.stringify(
          {
            compile: { name: 'syntax', command: 'node --check {files}' },
            rules: [{ name: 'NO_EVAL', command: 'node checks/no-eval.mjs {files}' }],
            lockedFiles: ['checks/no-eval.mjs'],
          },
          null,
          2
        ) + '\n'
      );
      write(checkDir, 'src/parser.mjs', 'export function parsePayload(raw) {\n  return JSON.parse(raw);\n}\n');
      git(['add', '.'], checkDir);
      git(['commit', '-m', 'chore: baseline with check config'], checkDir);

      const lockRulesExit = await runCheck({ cwd: checkDir, lock: true });
      assert.equal(lockRulesExit, 0);

      console.log('\n[Step 5.1] Source file uses forbidden eval() -> caught with bare report (fix hint stripped):');
      write(checkDir, 'src/parser.mjs', 'export function parsePayload(raw) {\n  return eval(raw);\n}\n');
      const s5Violate = await runCheck({ cwd: checkDir, files: ['src/parser.mjs'] });
      console.log(`-> bastion check exited with: ${s5Violate} (expected 1)`);
      assert.equal(s5Violate, 1);

      console.log('\n[Step 5.2] Someone edits locked checks/no-eval.mjs -> tamper detected and aborted:');
      write(checkDir, 'checks/no-eval.mjs', 'process.exit(0);\n');
      const s5Tamper = await runCheck({ cwd: checkDir, files: ['src/parser.mjs'] });
      console.log(`-> bastion check exited with: ${s5Tamper} (expected 1)`);
      assert.equal(s5Tamper, 1);

      console.log('\n[Step 5.3] Restore locked rule script and fix src/parser.mjs -> check passes:');
      git(['checkout', '--', 'checks/no-eval.mjs'], checkDir);
      write(checkDir, 'src/parser.mjs', 'export function parsePayload(raw) {\n  return JSON.parse(raw);\n}\n');
      const s5Pass = await runCheck({ cwd: checkDir, files: ['src/parser.mjs'] });
      console.log(`-> bastion check exited with: ${s5Pass} (expected 0)`);
      assert.equal(s5Pass, 0);
    } finally {
      fs.rmSync(checkDir, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(demoRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
