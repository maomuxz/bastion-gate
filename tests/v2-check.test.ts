// v2 - `bastion check`: compile + locked hard-rule bare-error gate (no fix hints) with <=2 rework rounds
// and locked-file tamper detection reusing bastion's lock & runner primitives.
import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'node:test';
import { parseBareFindings, parseCheckConfig, stripFixHints } from '../src/check-core.js';
import { executeCheck, runCheck } from '../src/commands/check.js';
import { runInit } from '../src/commands/init.js';
import { runLock } from '../src/commands/lock.js';
import { captureConsole, cleanupTempRepos, createTempGitRepo, git, writeRepoFile } from './v04-helpers.js';

afterEach(cleanupTempRepos);

const CLI_JS = fileURLToPath(new URL('../src/cli.js', import.meta.url));

function createCheckFixtureRepo(): string {
  const repo = createTempGitRepo();
  // Fake compiler: checks for `BAD_CALL()` or `UNKNOWN_PARAM:` and emits Dart machine format WITH a `Try ...` hint
  writeRepoFile(
    repo,
    'scripts/fake-compile.mjs',
    [
      "import * as fs from 'node:fs';",
      "import * as path from 'node:path';",
      'const args = process.argv.slice(2);',
      "const files = args.length > 0 && args[0] !== '.' ? args : ['lib/panel.dart'];",
      'let errs = 0;',
      'for (const f of files) {',
      "  const lines = fs.readFileSync(f, 'utf8').split(/\\r?\\n/);",
      '  lines.forEach((line, idx) => {',
      "    if (line.includes('BAD_CALL()')) {",
      "      console.log(`ERROR|COMPILE_TIME_ERROR|INSTANTIATE_ABSTRACT_CLASS|${path.resolve(f)}|${idx + 1}|5|8|Abstract classes can't be instantiated. Try calling the static method AcmeToast.show instead.`);",
      '      errs++;',
      '    }',
      "    if (line.includes('UNKNOWN_PARAM:')) {",
      "      console.log(`ERROR|COMPILE_TIME_ERROR|UNDEFINED_NAMED_PARAMETER|${path.resolve(f)}|${idx + 1}|7|4|The named parameter 'type' isn't defined. Try correcting the name to 'kind'.`);",
      '      errs++;',
      '    }',
      '  });',
      '}',
      'process.exit(errs > 0 ? 1 : 0);',
      '',
    ].join('\n')
  );

  // Locked hard-rule script: flags raw hex colors and raw dialogs WITH fix hints that `bastion check` must strip
  writeRepoFile(
    repo,
    'checks/check_rules.mjs',
    [
      "import * as fs from 'node:fs';",
      "const targets = ['lib/panel.dart', 'lib/other.dart'].filter((f) => fs.existsSync(f));",
      'let bad = 0;',
      'for (const f of targets) {',
      "  const lines = fs.readFileSync(f, 'utf8').split(/\\r?\\n/);",
      '  lines.forEach((line, idx) => {',
      "    if (line.includes('Color(0x')) {",
      '      console.error(`${f}:${idx + 1}  颜色值只能写在 lib/ui/tokens/，请用 AcmeTokens`);',
      '      bad++;',
      '    }',
      "    if (line.includes('showDialog(')) {",
      '      console.error(`${f}:${idx + 1}  弹窗请用 showAcmeDialog`);',
      '      bad++;',
      '    }',
      '  });',
      '}',
      'process.exit(bad > 0 ? 1 : 0);',
      '',
    ].join('\n')
  );

  writeRepoFile(repo, 'lib/panel.dart', 'void renderPanel() {}\n');
  writeRepoFile(
    repo,
    '.bastion/check.json',
    JSON.stringify(
      {
        compile: { name: 'compile', command: 'node scripts/fake-compile.mjs {files}' },
        rules: [{ name: 'C_RULE', command: 'node checks/check_rules.mjs' }],
        lockedFiles: ['checks/check_rules.mjs', 'scripts/fake-compile.mjs'],
        maxRetries: 2,
      },
      null,
      2
    ) + '\n'
  );
  git(['add', '.'], repo);
  git(['commit', '-m', 'chore: baseline with check scripts'], repo);
  return repo;
}

describe('v2 check: fix-hint stripping and diagnostic parsing', () => {
  it('strips English compiler Try/Use/Did-you-mean hints and Chinese remediation suffixes', () => {
    assert.equal(
      stripFixHints("The named parameter 'type' isn't defined. Try correcting the name to an existing named parameter."),
      "The named parameter 'type' isn't defined."
    );
    assert.equal(
      stripFixHints('颜色值只能写在 lib/ui/tokens/，请用 AcmeTokens.of(context)'),
      '颜色值只能写在 lib/ui/tokens/'
    );
    assert.equal(
      stripFixHints('lib/core/ 严禁引入界面框架包；若需 FontWeight 请改为 import dart:ui'),
      'lib/core/ 严禁引入界面框架包'
    );
    assert.equal(
      stripFixHints('弹窗请用 showAcmeDialog / acmeConfirm'),
      '禁止直接使用该弹窗（违反统一组件约束）'
    );
    assert.equal(stripFixHints('请在密码模式下设置 visiblePassword'), '违反该项锁定规则');
  });

  it('parses Dart machine format, Dart human format, tsc format, and bracketed rule lines while ignoring INFO/WARNING', () => {
    const root = path.resolve('/tmp/proj');
    const out = [
      `INFO|LINT|PREFER_CONST|${path.join(root, 'lib/a.dart')}|3|1|4|Prefer const. Try adding const.`,
      `WARNING|STATIC_WARNING|DEAD_CODE|${path.join(root, 'lib/a.dart')}|5|1|4|Dead code. Try removing it.`,
      `ERROR|COMPILE_TIME_ERROR|UNDEFINED_GETTER|${path.join(root, 'lib/a.dart')}|12|9|3|The getter 'foo' isn't defined. Try defining 'foo'.`,
      'error • Undefined name \'Bar\'. Try importing bar.dart. • lib/b.dart:27:4 • undefined_identifier',
      'src/c.ts(9,3): error TS2304: Cannot find name \'baz\'. Did you mean \'bar\'?',
      'lib/d.dart:44 违反规则 [R06]：严禁使用半透明组件实现禁用态，请改用语义色',
    ].join('\n');

    const findings = parseBareFindings(out, 'rule', root, root);
    assert.deepEqual(findings, [
      { file: 'lib/a.dart', line: 12, rule: 'UNDEFINED_GETTER', message: "The getter 'foo' isn't defined." },
      { file: 'lib/b.dart', line: 27, rule: 'UNDEFINED_IDENTIFIER', message: "Undefined name 'Bar'." },
      { file: 'src/c.ts', line: 9, rule: 'TS2304', message: "Cannot find name 'baz'." },
      { file: 'lib/d.dart', line: 44, rule: 'R06', message: '严禁使用半透明组件实现禁用态' },
    ]);
  });
});

describe('v2 check: compile + locked rules + tamper detection + <=2 rework rounds', () => {
  it('passes on clean code and produces bare file:line [rule] report without fix hints on violations', async () => {
    const repo = createCheckFixtureRepo();
    assert.equal((await captureConsole(() => runCheck({ cwd: repo, lock: true }))).result, 0);
    assert.equal((await captureConsole(() => runCheck({ cwd: repo }))).result, 0);

    // Introduce 1 compile error + 2 rule violations in lib/panel.dart
    writeRepoFile(
      repo,
      'lib/panel.dart',
      [
        'void renderPanel() {',
        '  BAD_CALL();',
        '  final c = Color(0xFF112233);',
        '  showDialog();',
        '}',
        '',
      ].join('\n')
    );

    const summary = await executeCheck({ cwd: repo, files: ['lib/panel.dart'] });
    assert.equal(summary.ok, false);
    assert.equal(summary.findings.length, 3);
    assert.ok(summary.report.includes("- lib/panel.dart:2 [INSTANTIATE_ABSTRACT_CLASS] Abstract classes can't be instantiated."), summary.report);
    assert.ok(summary.report.includes('- lib/panel.dart:3 [C_RULE] 颜色值只能写在 lib/ui/tokens/'), summary.report);
    assert.ok(summary.report.includes('- lib/panel.dart:4 [C_RULE] 禁止直接使用该弹窗（违反统一组件约束）'), summary.report);
    // Verify ALL fix hints were stripped!
    assert.ok(!summary.report.includes('AcmeToast.show'), 'compiler Try hint stripped');
    assert.ok(!summary.report.includes('AcmeTokens'), 'Chinese replacement class hint stripped');
    assert.ok(!summary.report.includes('showAcmeDialog'), 'compact replacement hint stripped');
  });

  it('scopes global rule output to explicit target [files...]', async () => {
    const repo = createCheckFixtureRepo();
    assert.equal((await captureConsole(() => runCheck({ cwd: repo, lock: true }))).result, 0);
    // Put a rule issue in unrelated `lib/other.dart`, keep `lib/panel.dart` clean
    writeRepoFile(repo, 'lib/other.dart', 'final bad = Color(0xFF000000);\n');
    const scoped = await executeCheck({ cwd: repo, files: ['lib/panel.dart'] });
    assert.equal(scoped.ok, true, scoped.report);

    const unscoped = await executeCheck({ cwd: repo });
    assert.equal(unscoped.ok, false);
    assert.equal(unscoped.findings[0]?.file, 'lib/other.dart');
  });

  it('detects tampering with check-locked rule scripts and bastion lock.json', async () => {
    const repo = createCheckFixtureRepo();
    assert.equal((await captureConsole(() => runCheck({ cwd: repo, lock: true }))).result, 0);

    // Tamper with locked rule script to make all rules pass
    writeRepoFile(repo, 'checks/check_rules.mjs', 'process.exit(0);\n');
    const tampered = await executeCheck({ cwd: repo });
    assert.equal(tampered.ok, false);
    assert.equal(tampered.tampered, true);
    assert.match(tampered.report, /Locked rule\/config file modified: checks\/check_rules\.mjs/);

    // Also test reuse of `.bastion/lock.json` integrity!
    const repo2 = createTempGitRepo();
    runInit({ cwd: repo2, testCommand: 'node --test tests/t.test.mjs', baseBranch: 'main' });
    writeRepoFile(repo2, 'src/x.mjs', 'export const x = 0;\n');
    writeRepoFile(
      repo2,
      'tests/t.test.mjs',
      "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { x } from '../src/x.mjs';\ntest('x is 1', () => assert.equal(x, 1));\n"
    );
    writeRepoFile(repo2, '.bastion/check.json', JSON.stringify({ compile: 'node -e "process.exit(0)"' }));
    git(['add', '.'], repo2);
    git(['commit', '-m', 'baseline'], repo2);
    assert.equal((await captureConsole(() => runLock({ cwd: repo2 }))).result, 0);
    git(['add', '.bastion/lock.json'], repo2);
    git(['commit', '-m', 'lock'], repo2);

    // Modify locked test file on feature branch -> `bastion check` reuses `gate.ts` integrity and fails!
    git(['checkout', '-b', 'feat/tamper'], repo2);
    writeRepoFile(repo2, 'tests/t.test.mjs', "import test from 'node:test';\ntest('tautology', () => {});\n");
    const lockFail = await executeCheck({ cwd: repo2, baseRef: 'main' });
    assert.equal(lockFail.ok, false);
    assert.equal(lockFail.tampered, true);
  });

  it('runs rework loop up to 2 rounds: fixes in 2 rounds when repairable, stops at 2 rounds when unfixed, and aborts on tamper', async () => {
    const repo = createCheckFixtureRepo();
    // Agent script: Round 1 fixes compile error but leaves Color(0x...), Round 2 fixes Color(0x...) too!
    // Also asserts the prompt fed to the agent contains zero fix hints!
    writeRepoFile(
      repo,
      'scripts/rework-agent.mjs',
      [
        "import * as fs from 'node:fs';",
        'const prompt = fs.readFileSync(process.env.BASTION_PROMPT_FILE, "utf8");',
        'if (prompt.includes("AcmeToast.show") || prompt.includes("AcmeTokens")) process.exit(99);',
        'const attempt = Number(process.env.BASTION_ATTEMPT);',
        'if (attempt === 1) {',
        '  fs.writeFileSync("lib/panel.dart", "void renderPanel() {\\n  final c = Color(0xFF123456);\\n}\\n");',
        '} else if (attempt === 2) {',
        '  fs.writeFileSync("lib/panel.dart", "void renderPanel() {\\n  final ok = true;\\n}\\n");',
        '}',
        '',
      ].join('\n')
    );
    git(['add', 'scripts/rework-agent.mjs'], repo);
    git(['commit', '-m', 'add rework agent'], repo);
    assert.equal((await captureConsole(() => runCheck({ cwd: repo, lock: true }))).result, 0);

    writeRepoFile(repo, 'lib/panel.dart', 'void renderPanel() {\n  BAD_CALL();\n  final c = Color(0xFF123456);\n}\n');
    const fixedIn2 = await executeCheck({
      cwd: repo,
      files: ['lib/panel.dart'],
      agentCommand: 'node scripts/rework-agent.mjs',
    });
    assert.equal(fixedIn2.ok, true, fixedIn2.report);
    assert.equal(fixedIn2.roundsUsed, 2);

    // Persistent failure: no-op agent must stop after exactly 2 rework rounds and exit 1
    writeRepoFile(repo, 'scripts/noop-agent.mjs', 'import * as fs from "node:fs"; fs.appendFileSync(".bastion/logs/calls.txt", "1\\n");\n');
    writeRepoFile(repo, 'lib/panel.dart', 'void renderPanel() {\n  BAD_CALL();\n}\n');
    const unfixed = await executeCheck({
      cwd: repo,
      files: ['lib/panel.dart'],
      agentCommand: 'node scripts/noop-agent.mjs',
    });
    assert.equal(unfixed.ok, false);
    assert.equal(unfixed.roundsUsed, 2);
    const callCount = fs.readFileSync(path.join(repo, '.bastion/logs/calls.txt'), 'utf8').trim().split(/\r?\n/).length;
    assert.equal(callCount, 2, 'at most 2 rework rounds executed');

    // Cheating agent that edits locked `checks/check_rules.mjs` on Round 1 -> caught immediately, no Round 2!
    writeRepoFile(repo, 'scripts/cheat-agent.mjs', 'import * as fs from "node:fs"; fs.writeFileSync("checks/check_rules.mjs", "process.exit(0);\\n");\n');
    const cheated = await executeCheck({
      cwd: repo,
      files: ['lib/panel.dart'],
      agentCommand: 'node scripts/cheat-agent.mjs',
    });
    assert.equal(cheated.ok, false);
    assert.equal(cheated.tampered, true);
    assert.equal(cheated.roundsUsed, 1, 'aborts rework immediately when locked file is tampered with');
  });
});

describe('v2 check: malformed and bad inputs', () => {
  it('rejects invalid JSON, missing compile command, invalid maxRetries (>2 or <0 or NaN), and missing locked/target files', () => {
    assert.throws(() => parseCheckConfig('{ broken', 'check.json'), /Invalid JSON/);
    assert.throws(() => parseCheckConfig('{}', 'check.json'), /missing required "compile"/);
    assert.throws(() => parseCheckConfig('{"compile":[]}', 'check.json'), /at least one command/);
    assert.throws(() => parseCheckConfig('{"compile":"true","maxRetries":3}', 'check.json'), /between 0 and 2/);
    assert.throws(() => parseCheckConfig('{"compile":"true","maxRetries":-1}', 'check.json'), /between 0 and 2/);
    assert.throws(() => parseCheckConfig('{"compile":"true","timeoutSeconds":0}', 'check.json'), /positive number/);

    const repo = createCheckFixtureRepo();
    // CLI `--max-retries 3` rejected
    const rMax = spawnSync(process.execPath, [CLI_JS, 'check', '--max-retries', '3'], { cwd: repo, encoding: 'utf8' });
    assert.equal(rMax.status, 1);
    assert.match(rMax.stderr, /between 0 and 2/);

    // CLI `--max-retries abc` rejected
    const rNan = spawnSync(process.execPath, [CLI_JS, 'check', '--max-retries', 'abc'], { cwd: repo, encoding: 'utf8' });
    assert.equal(rNan.status, 1);
    assert.match(rNan.stderr, /between 0 and 2/);

    // CLI missing target file rejected
    const rTarget = spawnSync(process.execPath, [CLI_JS, 'check', 'lib/does_not_exist.dart'], { cwd: repo, encoding: 'utf8' });
    assert.equal(rTarget.status, 1);
    assert.match(rTarget.stderr, /Target file does not exist/);

    // CLI `--lock` when a configured lockedFile doesn't exist rejected
    writeRepoFile(repo, '.bastion/check.json', JSON.stringify({ compile: 'node -e "process.exit(0)"', lockedFiles: ['checks/missing.mjs'] }));
    const rLockMissing = spawnSync(process.execPath, [CLI_JS, 'check', '--lock'], { cwd: repo, encoding: 'utf8' });
    assert.equal(rLockMissing.status, 1);
    assert.match(rLockMissing.stderr, /Locked rule\/config file does not exist/);
  });
});
