// v1.1 hardening (round 5) for `bastion tests`: a skipped or failed wall step must never look like a pass.
// H1 loud gap-check skip, H2 strict gap patches, H3 dependency scan failures are fatal.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { runTests } from '../src/commands/tests.js';
import { mapToPlan } from '../src/map.js';
import { captureConsole, cleanupTempRepos, git } from './v04-helpers.js';
import { createRoleRepo, readRoleCalls, sampleMap, SAMPLE_FILES } from './v1-helpers.js';
import type { RoleFixture, RoleFixtures } from './v1-helpers.js';

afterEach(cleanupTempRepos);

const T = SAMPLE_FILES.tests;
const ADD = 'tests/add.test.mjs';
const MUL = 'tests/mul.test.mjs';
const REQ_TEXT = ['The calculator adds two numbers.', 'add must treat -0 as 0.'].join('\n');
const Q_ADD = 'add must treat -0 as 0.';
const GAP_ADD = { rule: 'add treats negative zero as zero', quote: Q_ADD, file: ADD };

const ORIG_ADD = `${T[ADD]}test('add zero', () => { assert.equal(add(0, 0), 0); });\n`;
const CASE1 = `test('add negative zero', () => { assert.equal(add(-0, 0), 0); });\n`;
const CASE2 = `test('add large', () => { assert.equal(add(1e6, 1), 1000001); });\n`;

const SKIP_LINE = '[bastion] tests: no .bastion/requirement.md - the gap check was skipped; locking without it.';
const SKIP_MD = '# Gap check\n\nSkipped: no .bastion/requirement.md, so there was nothing to check the tests against.\n';

const report = (...gaps: Array<Record<string, unknown>>): RoleFixture => ({ output: { gaps } });

function makeRepo(fx: RoleFixtures, requirement: string | null = `# Requirement\n\n${REQ_TEXT}\n`, extra: Record<string, string> = {}): string {
  const repo = createRoleRepo({
    fixtures: fx,
    files: {
      '.bastion/map.json': JSON.stringify(sampleMap(), null, 2),
      '.bastion/interfaces.md': '# Interfaces\n',
      ...SAMPLE_FILES.stubs,
      ...extra,
    },
  });
  if (requirement !== null) fs.writeFileSync(path.join(repo, '.bastion', 'requirement.md'), requirement);
  return repo;
}

/** Base tester output (n1 has two cases) plus optional per-label overrides. */
function fx(critic: RoleFixture | undefined, over: Record<string, RoleFixture> = {}): RoleFixtures {
  const byLabel: Record<string, RoleFixture> = {
    'tests-n1': { files: { [ADD]: ORIG_ADD } },
    'tests-n2': { files: { [MUL]: T[MUL] } },
    ...over,
  };
  const f: RoleFixtures = { tester: { byLabel } };
  if (critic) f.critic = critic;
  return f;
}

const criticCalls = (repo: string) => readRoleCalls(repo).filter((c) => c.role === 'critic');
const lockPath = (repo: string) => path.join(repo, '.bastion', 'lock.json');
const gapsPath = (repo: string) => path.join(repo, '.bastion', 'gaps.md');
const head = (repo: string) => git(['rev-parse', 'HEAD'], repo);

describe('H1: a skipped gap check is loud and recorded', () => {
  for (const [name, requirement] of [['missing requirement file', null], ['blank requirement file', ' \n\t\n']] as const) {
    it(`${name} with lock: line on stderr, exact gaps.md committed with the lock, exit 0`, async () => {
      const repo = makeRepo(fx(report(GAP_ADD)), requirement);
      const { result, err } = await captureConsole(() => runTests({ cwd: repo, lock: true }));
      assert.equal(result, 0);
      assert.equal(criticCalls(repo).length, 0);
      assert.ok(err.split(/\r?\n/).includes(SKIP_LINE), `stderr was: ${err}`);
      assert.equal(fs.readFileSync(gapsPath(repo), 'utf8'), SKIP_MD);
      assert.ok(fs.existsSync(lockPath(repo)));
      assert.equal(git(['log', '-n', '1', '--format=%s'], repo), 'test(bastion): lock acceptance tests');
      const files = git(['show', '--name-only', '--format=', 'HEAD'], repo).split(/\r?\n/);
      assert.ok(files.includes('.bastion/gaps.md'), `lock commit files: ${files.join(',')}`);
      assert.ok(files.includes('.bastion/lock.json'));
      assert.equal(git(['status', '--porcelain'], repo), '');
    });
  }

  it('gaps:false prints no skip line and writes no gaps.md', async () => {
    const repo = makeRepo(fx(report(GAP_ADD)), null);
    const { result, err } = await captureConsole(() => runTests({ cwd: repo, lock: true, gaps: false }));
    assert.equal(result, 0);
    assert.ok(!err.includes('gap check was skipped'));
    assert.equal(fs.existsSync(gapsPath(repo)), false);
    assert.ok(fs.existsSync(lockPath(repo)));
  });

  it('without lock nothing is printed or written either', async () => {
    const repo = makeRepo(fx(report(GAP_ADD)), null);
    const { result, err } = await captureConsole(() => runTests({ cwd: repo }));
    assert.equal(result, 0);
    assert.ok(!err.includes('gap check was skipped'));
    assert.equal(fs.existsSync(gapsPath(repo)), false);
  });
});

describe('H2: a gap patch must add cases, keep every old case and touch only its own file', () => {
  async function expectPatchFailure(patch: RoleFixture, expectedLine: string): Promise<void> {
    const repo = makeRepo(fx(report(GAP_ADD), { 'tests-n1-gaps': patch }));
    const before = head(repo);
    const { result, err } = await captureConsole(() => runTests({ cwd: repo, lock: true }));
    assert.equal(result, 1);
    assert.ok(err.split(/\r?\n/).includes(expectedLine), `expected line "${expectedLine}" in stderr: ${err}`);
    assert.equal(fs.existsSync(lockPath(repo)), false);
    assert.equal(head(repo), before, 'no new commit');
    assert.ok(readRoleCalls(repo).some((c) => c.label === 'tests-n1-gaps'), 'the patch was attempted');
  }

  it('a comment-only patch added no case', async () => {
    await expectPatchFailure({ files: { [ADD]: `${ORIG_ADD}// we really should test negative zero here\n` } }, `[bastion] tests: gap patch for n1 added no test case to ${ADD}.`);
  });

  it('a commented-out test() call is not a new case', async () => {
    await expectPatchFailure(
      { files: { [ADD]: `${ORIG_ADD}// test('add negative zero', () => {});\n` } },
      `[bastion] tests: gap patch for n1 added no test case to ${ADD}.`
    );
  });

  it('replacing one case by another (same count) reports the removed name', async () => {
    const replaced = ORIG_ADD.replace("test('add zero'", "test('add zero renamed'");
    assert.notEqual(replaced, ORIG_ADD);
    await expectPatchFailure({ files: { [ADD]: replaced } }, `[bastion] tests: gap patch for n1 removed test case(s) from ${ADD}: add zero.`);
  });

  it('adding a case while removing/renaming old ones lists every missing name', async () => {
    const src = `${T[ADD].replace("test('add'", "test('add basic'")}${CASE1}${CASE2}`;
    // before: add, add zero; after: add basic, add negative zero, add large -> 3 > 2 cases, but two names are gone
    await expectPatchFailure({ files: { [ADD]: src } }, `[bastion] tests: gap patch for n1 removed test case(s) from ${ADD}: add, add zero.`);
  });

  it('editing another node\'s test file is rejected even if the own file got a new case', async () => {
    await expectPatchFailure(
      { files: { [ADD]: `${ORIG_ADD}${CASE1}`, [MUL]: `${T[MUL]}// sneaky\n` } },
      `[bastion] tests: gap patch for n1 changed another node's test file: ${MUL}.`
    );
  });

  it('good path: two new cases -> 0, committed, locked, note says (2 new case(s))', async () => {
    const repo = makeRepo(fx(report(GAP_ADD), { 'tests-n1-gaps': { files: { [ADD]: `${ORIG_ADD}${CASE1}${CASE2}` } } }));
    const { result } = await captureConsole(() => runTests({ cwd: repo, lock: true }));
    assert.equal(result, 0);
    assert.ok(fs.existsSync(lockPath(repo)));
    const md = fs.readFileSync(gapsPath(repo), 'utf8');
    assert.ok(md.includes('Patched by the tester: n1 (2 new case(s)). The patch was not re-checked by the critic.'), md);
    assert.equal(git(['ls-files', '.bastion/gaps.md'], repo), '.bastion/gaps.md');
  });

  it('the new-case count is the total over all patched files', async () => {
    const gapMul = { rule: 'mul rejects negatives', quote: 'The calculator adds two numbers.', file: MUL };
    const repo = makeRepo(
      fx(report(GAP_ADD, gapMul), {
        'tests-n1-gaps': { files: { [ADD]: `${ORIG_ADD}${CASE1}${CASE2}` } },
        'tests-n2-gaps': { files: { [MUL]: `${T[MUL]}test('mul by zero', () => { assert.equal(mul(0, 5), 0); });\n` } },
      })
    );
    const { result } = await captureConsole(() => runTests({ cwd: repo, lock: true }));
    assert.equal(result, 0);
    assert.ok(fs.readFileSync(gapsPath(repo), 'utf8').includes('Patched by the tester: n1, n2 (3 new case(s)). The patch was not re-checked by the critic.'));
  });
});

describe('H3: the dependency scan is fatal when it fails or finds a cycle', () => {
  it('an unparsable plan.json -> 1, stderr line, nothing committed or locked', async () => {
    const repo = makeRepo(fx(report()), null, { '.bastion/plan.json': '{ this is not json' });
    assert.equal(git(['status', '--porcelain'], repo), '');
    const before = head(repo);
    const { result, err } = await captureConsole(() => runTests({ cwd: repo, lock: true }));
    assert.equal(result, 1);
    assert.match(err, /^\[bastion\] tests: dependency scan failed: .+/m);
    assert.ok(!err.includes('dependency scan skipped'));
    assert.equal(fs.existsSync(lockPath(repo)), false);
    assert.equal(head(repo), before, 'no test commit');
  });

  it('an unparsable plan.json also fails without --lock', async () => {
    const repo = makeRepo(fx(undefined), null, { '.bastion/plan.json': '{ nope' });
    const before = head(repo);
    const { result, err } = await captureConsole(() => runTests({ cwd: repo }));
    assert.equal(result, 1);
    assert.match(err, /^\[bastion\] tests: dependency scan failed: /m);
    assert.equal(head(repo), before);
  });

  it('a cycle (n1 test imports n2 file, n2 depends on n1) prints the line and returns 1', async () => {
    const cyclic = `import { mul } from '../src/mul.mjs';\n${ORIG_ADD}void mul;\n`;
    const repo = makeRepo(fx(report(), { 'tests-n1': { files: { [ADD]: cyclic } } }), null, {
      '.bastion/plan.json': JSON.stringify(mapToPlan(sampleMap()), null, 2) + '\n',
    });
    const { result, err } = await captureConsole(() => runTests({ cwd: repo, lock: true }));
    assert.equal(result, 1);
    assert.ok(
      err.split(/\r?\n/).includes('[bastion] tests: the test of n1 imports src/mul.mjs owned by n2, but n2 depends on n1; fix the map.'),
      `stderr was: ${err}`
    );
    assert.equal(fs.existsSync(lockPath(repo)), false);
  });
});
