// v2 - `bastion sheet`: Dart public API cheatsheet extractor (static modifier preservation, barrel/show/hide,
// ThemeExtension compacting, regeneration on source edits, and malformed input rejection).
import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'node:test';
import { runSheet } from '../src/commands/sheet.js';
import { parseDartSource, parseSheetConfig, stripDartComments } from '../src/sheet.js';
import { captureConsole, cleanupTempRepos, createTempGitRepo, writeRepoFile } from './v04-helpers.js';

afterEach(cleanupTempRepos);

const CLI_JS = fileURLToPath(new URL('../src/cli.js', import.meta.url));

function createAcmeDartFixture(): string {
  const repo = createTempGitRepo();
  writeRepoFile(repo, 'pubspec.yaml', 'name: acme_kit\nversion: 0.1.0\n');
  writeRepoFile(
    repo,
    'checks/check_rules.dart',
    [
      '// Style checks for acme_kit.',
      '// 1. Color literals are only allowed inside lib/ui/tokens/.',
      '// 2. Outside lib/ui/, always use unified Acme controls instead of raw framework widgets.',
      'void main() {}',
      '',
    ].join('\n')
  );
  writeRepoFile(
    repo,
    'lib/app/run_mode.dart',
    [
      'enum RunMode {',
      '  dev(apiBase: "http://127.0.0.1:8080"),',
      '  prod(apiBase: "https://api.example.com");',
      '  const RunMode({required this.apiBase});',
      '  final String apiBase;',
      '  static const RunMode current = RunMode.dev;',
      '  bool get isDev => this == RunMode.dev;',
      '}',
      '',
    ].join('\n')
  );
  writeRepoFile(
    repo,
    'lib/ui/tokens/tokens.dart',
    [
      'class AcmeTokens extends ThemeExtension<AcmeTokens> {',
      '  const AcmeTokens({required this.primary, required this.surface, required this.ink});',
      '  final Color primary;',
      '  final Color surface;',
      '  final Color ink;',
      '  static AcmeTokens of(BuildContext context) => throw UnimplementedError();',
      '  Color? badgeColor(String tag) => null;',
      '  @override',
      '  AcmeTokens copyWith({Color? primary}) => this;',
      '  @override',
      '  AcmeTokens lerp(covariant ThemeExtension<AcmeTokens>? other, double t) => this;',
      '}',
      'abstract final class AcmeSpace {',
      '  static const double xs = 4;',
      '  static const double md = 12;',
      '}',
      '',
    ].join('\n')
  );
  writeRepoFile(
    repo,
    'lib/ui/base/button.dart',
    [
      'enum AcmeButtonKind { primary, secondary, danger }',
      'typedef LabelFormatter = String Function(int count);',
      'class AcmeButton extends StatelessWidget {',
      '  const AcmeButton({',
      '    super.key,',
      '    required this.label,',
      '    this.onPressed,',
      '    this.kind = AcmeButtonKind.secondary,',
      '    this.expand = false,',
      '  });',
      '  const AcmeButton.danger({super.key, required this.label, this.onPressed})',
      '    : kind = AcmeButtonKind.danger, expand = false;',
      '  const AcmeButton._internal({required this.label}) : onPressed = null, kind = AcmeButtonKind.primary, expand = false;',
      '  final String label;',
      '  final VoidCallback? onPressed;',
      '  final AcmeButtonKind kind;',
      '  final bool expand;',
      '  static const double defaultHeight = 36;',
      '}',
      '',
    ].join('\n')
  );
  writeRepoFile(
    repo,
    'lib/ui/shell/toast.dart',
    [
      '/* Nested /* block comment with fake class Bogus {} */ inside */',
      'abstract final class AcmeToast {',
      '  static void show(',
      '    BuildContext context,',
      '    String message, {',
      '    int milliseconds = 2500,',
      '    VoidCallback? onDismissed,',
      '  }) {}',
      '  static void _privateHelper() {}',
      '}',
      'Future<T?> showAcmeDialog<T>(BuildContext context, {required WidgetBuilder builder, bool dismissible = true}) async => null;',
      '',
    ].join('\n')
  );
  writeRepoFile(
    repo,
    'lib/ui/shell/escape_coord.dart',
    [
      'abstract final class AcmeEscape {',
      '  static void claim(KeyEvent event) {}',
      '  static bool get claimedJustNow => false;',
      '  static void hold(Object owner) {}',
      '  static void release(Object owner) {}',
      '  static bool get held => false;',
      '}',
      '',
    ].join('\n')
  );
  writeRepoFile(
    repo,
    'lib/ui/shell/filtered.dart',
    [
      'class PublicShown { const PublicShown(); }',
      'class SecretHidden { const SecretHidden(); }',
      '',
    ].join('\n')
  );
  writeRepoFile(
    repo,
    'lib/ui/ui.dart',
    [
      "export 'tokens/tokens.dart';",
      "export 'base/button.dart';",
      "export 'shell/toast.dart';",
      "export 'shell/filtered.dart' show PublicShown;",
      '',
    ].join('\n')
  );
  writeRepoFile(
    repo,
    '.bastion/sheet.json',
    JSON.stringify(
      {
        language: 'dart',
        output: '.bastion/sheet.md',
        title: 'Acme Kit Cheatsheet',
        ruleFiles: ['checks/check_rules.dart'],
        notes: ['Layering: `lib/core/` has zero UI imports; `lib/features/` imports `package:acme_kit/ui/ui.dart`.'],
        entries: [
          'lib/app/run_mode.dart',
          {
            path: 'lib/ui/ui.dart',
            title: "Unified UI (`import 'package:acme_kit/ui/ui.dart';`)",
            exportPrefixes: ['tokens/', 'base/', 'shell/'],
            discoverUnexportedDirs: ['shell'],
          },
        ],
      },
      null,
      2
    ) + '\n'
  );
  return repo;
}

describe('v2 sheet: Dart parser & static modifier accuracy', () => {
  it('preserves raw strings and strips nested block comments without leaking fake declarations', () => {
    const raw = [
      '/* outer /* inner class FakeInComment {} */ end */',
      '// line comment with enum FakeEnum { a, b }',
      "final pat = RegExp(r'[\\r\\n]//not-a-comment');",
      'abstract final class StaticBox {',
      '  static void run(String s, {String sep = "//"}) {}',
      '  static bool get ready => true;',
      '}',
    ].join('\n');
    const stripped = stripDartComments(raw, false);
    assert.ok(!stripped.includes('FakeInComment'));
    assert.ok(!stripped.includes('FakeEnum'));
    assert.ok(stripped.includes("r'[\\r\\n]//not-a-comment'"));

    const parsed = parseDartSource(raw);
    assert.equal(parsed.symbols.length, 1);
    assert.equal(
      parsed.symbols[0]!.line,
      'abstract final class StaticBox { static void run(String s, {String sep = "//"}), static bool get ready }'
    );
  });

  it('generates sheet from config, marks static utility classes/methods explicitly, and handles unexported + show/hide files', async () => {
    const repo = createAcmeDartFixture();
    const { result, out, err } = await captureConsole(() => runSheet({ cwd: repo }));
    assert.equal(result, 0, err);
    assert.match(out, /wrote \.bastion\/sheet\.md/);

    const md = fs.readFileSync(path.join(repo, '.bastion', 'sheet.md'), 'utf8');
    // Rules header & notes
    assert.ok(md.includes('- 1. Color literals are only allowed inside lib/ui/tokens/.'));
    assert.ok(md.includes('- 2. Outside lib/ui/, always use unified Acme controls'));
    assert.ok(md.includes('Layering: `lib/core/` has zero UI imports'));

    // Standalone entry with inferred package:acme_kit/... URI and enhanced enum static + getter
    assert.ok(md.includes('[`package:acme_kit/app/run_mode.dart`] `enum RunMode {dev, prod} (static current, .apiBase, .isDev)`') || md.includes('[`package:acme_kit/app/run_mode.dart`] `enum RunMode {dev, prod} (static current, .isDev)`'), md);

    // Unexported sibling in shell/ automatically surfaced with standalone import warning AND `static` keywords!
    assert.ok(
      md.includes(
        '[`package:acme_kit/ui/shell/escape_coord.dart` (not re-exported by ui.dart; import directly)] `abstract final class AcmeEscape { static void claim(KeyEvent event), static bool get claimedJustNow, static void hold(Object owner), static void release(Object owner), static bool get held }`'
      ),
      md
    );

    // ThemeExtension compacted automatically without copyWith/lerp noise
    assert.ok(md.includes('`AcmeTokens.of(context) -> primary, surface, ink; Color? badgeColor(String tag)`'), md);

    // Static-only abstract final class explicitly carries `abstract final class` AND `static void show(...)`
    assert.ok(
      md.includes(
        '`abstract final class AcmeToast { static void show(BuildContext context, String message, {int milliseconds = 2500, VoidCallback? onDismissed}) }`'
      ),
      md
    );
    assert.ok(!md.includes('_privateHelper'), 'private static methods excluded');
    assert.ok(!md.includes('_internal'), 'private named constructors excluded');

    // Named public constructor + field types resolved from `this.*`
    assert.ok(
      md.includes(
        '`AcmeButton({required String label, VoidCallback? onPressed, AcmeButtonKind kind = AcmeButtonKind.secondary, bool expand = false}); AcmeButton.danger({required String label, VoidCallback? onPressed}); static defaultHeight`'
      ),
      md
    );

    // Barrel `show` combinator respected
    assert.ok(md.includes('`PublicShown()`'));
    assert.ok(!md.includes('SecretHidden'));
  });

  it('detects stale output with --check when source code changes and passes again after regenerating', async () => {
    const repo = createAcmeDartFixture();
    assert.equal((await captureConsole(() => runSheet({ cwd: repo }))).result, 0);
    assert.equal((await captureConsole(() => runSheet({ cwd: repo, checkOnly: true }))).result, 0);

    // Modify Dart source signature -> `--check` must fail (exit 1)
    writeRepoFile(
      repo,
      'lib/ui/shell/toast.dart',
      [
        'abstract final class AcmeToast {',
        '  static void show(BuildContext context, String message, {bool urgent = false}) {}',
        '}',
        '',
      ].join('\n')
    );
    const stale = await captureConsole(() => runSheet({ cwd: repo, checkOnly: true }));
    assert.equal(stale.result, 1);
    assert.match(stale.err, /out of date/);

    // Regenerate via CLI subprocess -> updated signature appears and --check passes
    const cliRun = spawnSync(process.execPath, [CLI_JS, 'sheet'], { cwd: repo, encoding: 'utf8' });
    assert.equal(cliRun.status, 0, cliRun.stderr);
    const updatedMd = fs.readFileSync(path.join(repo, '.bastion', 'sheet.md'), 'utf8');
    assert.ok(updatedMd.includes('bool urgent = false'));
    assert.equal((await captureConsole(() => runSheet({ cwd: repo, checkOnly: true }))).result, 0);
  });

  it('handles circular barrel exports without infinite recursion', async () => {
    const repo = createTempGitRepo();
    writeRepoFile(repo, 'lib/a.dart', "export 'b.dart';\nclass Alpha { const Alpha(); }\n");
    writeRepoFile(repo, 'lib/b.dart', "export 'a.dart';\nclass Beta { const Beta(); }\n");
    writeRepoFile(repo, '.bastion/sheet.json', JSON.stringify({ language: 'dart', entries: ['lib/a.dart'] }));

    const { result, err } = await captureConsole(() => runSheet({ cwd: repo }));
    assert.equal(result, 0, err);
    const md = fs.readFileSync(path.join(repo, '.bastion', 'sheet.md'), 'utf8');
    assert.ok(md.includes('`Alpha()`') && md.includes('`Beta()`'));
  });
});

describe('v2 sheet: malformed and bad inputs', () => {
  it('rejects invalid JSON, non-object config, unsupported language, and empty entries', () => {
    assert.throws(() => parseSheetConfig('{ broken json', 'sheet.json'), /Invalid JSON/);
    assert.throws(() => parseSheetConfig('[]', 'sheet.json'), /JSON object/);
    assert.throws(() => parseSheetConfig('{"language":"python","entries":["a.py"]}', 'sheet.json'), /unsupported language "python"/);
    assert.throws(() => parseSheetConfig('{"language":"dart","entries":[]}', 'sheet.json'), /non-empty array/);
    assert.throws(() => parseSheetConfig('{"language":"dart","entries":[""]}', 'sheet.json'), /non-empty path/);
    assert.throws(() => parseSheetConfig('{"language":"dart","entries":[{}]}', 'sheet.json'), /entries\[0\]\.path/);
  });

  it('fails cleanly via CLI when config is missing, entry path does not exist, or barrel export target is missing', () => {
    const emptyRepo = createTempGitRepo();
    const r1 = spawnSync(process.execPath, [CLI_JS, 'sheet'], { cwd: emptyRepo, encoding: 'utf8' });
    assert.equal(r1.status, 1);
    assert.match(r1.stderr, /Missing \.bastion\/sheet\.json/);

    writeRepoFile(emptyRepo, '.bastion/sheet.json', JSON.stringify({ language: 'dart', entries: ['lib/nope.dart'] }));
    const r2 = spawnSync(process.execPath, [CLI_JS, 'sheet'], { cwd: emptyRepo, encoding: 'utf8' });
    assert.equal(r2.status, 1);
    assert.match(r2.stderr, /does not exist: lib\/nope\.dart/);

    writeRepoFile(emptyRepo, 'lib/bad_barrel.dart', "export 'missing_child.dart';\n");
    writeRepoFile(emptyRepo, '.bastion/sheet.json', JSON.stringify({ language: 'dart', entries: ['lib/bad_barrel.dart'] }));
    const r3 = spawnSync(process.execPath, [CLI_JS, 'sheet'], { cwd: emptyRepo, encoding: 'utf8' });
    assert.equal(r3.status, 1);
    assert.match(r3.stderr, /missing_child\.dart/);
  });

  it('does not crash on broken/unbalanced Dart source syntax', async () => {
    const repo = createTempGitRepo();
    writeRepoFile(
      repo,
      'lib/broken.dart',
      'class GoodBefore { const GoodBefore({required this.x}); final int x; }\nclass BrokenUnclosed {\n  const BrokenUnclosed(\n'
    );
    writeRepoFile(repo, '.bastion/sheet.json', JSON.stringify({ language: 'dart', entries: ['lib/broken.dart'] }));
    const { result, err } = await captureConsole(() => runSheet({ cwd: repo }));
    assert.equal(result, 0, err);
    const md = fs.readFileSync(path.join(repo, '.bastion', 'sheet.md'), 'utf8');
    assert.ok(md.includes('`GoodBefore({required int x})`'));
  });
});
