// v1.1 - `bastion tests`: requirement reaches the tester, and the gap check runs before locking.
// The critic is driven through fixtures (the fake role script); findGaps itself is never mocked.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { runTests } from '../src/commands/tests.js';
import { captureConsole, cleanupTempRepos, git } from './v04-helpers.js';
import { createRoleRepo, readRoleCalls, sampleMap, SAMPLE_FILES, setFixtures } from './v1-helpers.js';
import type { RoleFixture, RoleFixtures } from './v1-helpers.js';

afterEach(cleanupTempRepos);

const MARK = 'SHARED-INTERFACES-MARKER-9042';
const T = SAMPLE_FILES.tests;
const ADD = 'tests/add.test.mjs';
const MUL = 'tests/mul.test.mjs';

const REQ_TEXT = [
  'The calculator adds two numbers.',
  'mul must throw a RangeError when either argument is negative.',
  'add must treat -0 as 0.',
].join('\n');
const REQ = `# Requirement\n\n${REQ_TEXT}\n`;
const Q_MUL = 'mul must throw a RangeError when either argument is negative.';
const Q_ADD = 'add must treat -0 as 0.';

// n1 initially has two cases, so a patch that drops one is detectable by case count.
const ORIG_ADD = `${T[ADD]}test('add zero', () => { assert.equal(add(0, 0), 0); });\n`;
const STRONG_ADD = `${ORIG_ADD}test('add negative zero', () => { assert.equal(add(-0, 0), 0); });\n`;
const FEWER_ADD = `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/add.mjs';\ntest('add only', () => { assert.equal(add(2, 3), 5); assert.equal(add(1, 1), 2); });\n`;
const STRONG_MUL = `${T[MUL]}test('mul rejects negatives', () => { assert.throws(() => mul(-1, 2), RangeError); });\n`;

const GAP_MUL = { rule: 'mul rejects negative arguments', quote: Q_MUL, file: MUL };
const GAP_ADD = { rule: 'add treats negative zero as zero', quote: Q_ADD, file: ADD };

interface Fx {
  critic?: RoleFixture;
  n1Gaps?: string;
  n2Gaps?: string;
  n1GapsExit?: number;
}

function fixtures(o: Fx): RoleFixtures {
  const byLabel: Record<string, RoleFixture> = {
    'tests-n1': { files: { [ADD]: ORIG_ADD } },
    'tests-n2': { files: { [MUL]: T[MUL] } },
  };
  if (o.n1Gaps !== undefined) byLabel['tests-n1-gaps'] = { files: { [ADD]: o.n1Gaps }, exit: o.n1GapsExit };
  if (o.n2Gaps !== undefined) byLabel['tests-n2-gaps'] = { files: { [MUL]: o.n2Gaps } };
  const fx: RoleFixtures = { tester: { byLabel } };
  if (o.critic) fx.critic = o.critic;
  return fx;
}

const report = (...gaps: Array<Record<string, unknown>>): RoleFixture => ({ output: { gaps } });

function makeRepo(fx: RoleFixtures, requirement: string | null = REQ): string {
  const repo = createRoleRepo({
    fixtures: fx,
    files: {
      '.bastion/map.json': JSON.stringify(sampleMap(), null, 2),
      '.bastion/interfaces.md': `# Interfaces\n${MARK}\n`,
      ...SAMPLE_FILES.stubs,
    },
  });
  // .bastion/requirement.md is gitignored, so writing it keeps the working tree clean.
  if (requirement !== null) fs.writeFileSync(path.join(repo, '.bastion', 'requirement.md'), requirement);
  return repo;
}

const criticCalls = (repo: string) => readRoleCalls(repo).filter((c) => c.role === 'critic');
const testerCalls = (repo: string) => readRoleCalls(repo).filter((c) => c.role === 'tester');
const subjects = (repo: string) => git(['log', '--format=%s'], repo).split(/\r?\n/);
const lockPath = (repo: string) => path.join(repo, '.bastion', 'lock.json');
const gapsMd = (repo: string) => fs.readFileSync(path.join(repo, '.bastion', 'gaps.md'), 'utf8');

describe('v1.1 tests: requirement passthrough', () => {
  it('puts the requirement verbatim into every tester prompt and says the requirement wins', async () => {
    const repo = makeRepo(fixtures({}));
    const { result } = await captureConsole(() => runTests({ cwd: repo }));
    assert.equal(result, 0);
    const calls = testerCalls(repo);
    assert.equal(calls.length, 2);
    for (const c of calls) {
      assert.ok(c.prompt.includes('## Original requirement (source of truth)'), `${c.label}: heading`);
      assert.ok(c.prompt.includes(REQ_TEXT), `${c.label}: requirement text verbatim`);
      assert.match(c.prompt, /requirement wins/i, `${c.label}: precedence rule`);
      assert.ok(c.prompt.includes(MARK), 'interfaces still present');
    }
    const heading = calls[0].prompt.indexOf('## Original requirement (source of truth)');
    assert.ok(calls[0].prompt.indexOf(REQ_TEXT) > heading, 'text sits under the heading');
  });

  it('leaves the prompt unchanged without a requirement file, or with a blank one', async () => {
    for (const requirement of [null, '  \n\t\n']) {
      const repo = makeRepo(fixtures({}), requirement);
      const { result } = await captureConsole(() => runTests({ cwd: repo }));
      assert.equal(result, 0);
      for (const c of testerCalls(repo)) {
        assert.ok(!c.prompt.includes('Original requirement'), `no requirement section for ${JSON.stringify(requirement)}`);
        assert.ok(!/source of truth/i.test(c.prompt));
        assert.ok(c.prompt.includes(MARK));
      }
    }
  });
});

describe('v1.1 tests: when the critic is (not) called', () => {
  it('does not call the critic without --lock', async () => {
    const repo = makeRepo(fixtures({ critic: report(GAP_MUL) }));
    const { result } = await captureConsole(() => runTests({ cwd: repo }));
    assert.equal(result, 0);
    assert.equal(criticCalls(repo).length, 0);
    assert.equal(testerCalls(repo).length, 2, 'no gap patch either');
    assert.equal(fs.existsSync(path.join(repo, '.bastion', 'gaps.md')), false);
  });

  it('does not call the critic with gaps:false, but still locks', async () => {
    const repo = makeRepo(fixtures({ critic: report(GAP_MUL) }));
    const { result } = await captureConsole(() => runTests({ cwd: repo, lock: true, gaps: false }));
    assert.equal(result, 0);
    assert.equal(criticCalls(repo).length, 0);
    assert.equal(testerCalls(repo).length, 2);
    assert.ok(fs.existsSync(lockPath(repo)));
    assert.equal(fs.existsSync(path.join(repo, '.bastion', 'gaps.md')), false);
  });

  it('does not call the critic without a (non-blank) requirement, but still locks', async () => {
    for (const requirement of [null, ' \n ']) {
      const repo = makeRepo(fixtures({ critic: report(GAP_MUL) }), requirement);
      const { result } = await captureConsole(() => runTests({ cwd: repo, lock: true }));
      assert.equal(result, 0);
      assert.equal(criticCalls(repo).length, 0);
      assert.ok(fs.existsSync(lockPath(repo)));
      // v1.1 round 5 (H1): the skip is recorded, not silent
      assert.equal(gapsMd(repo), '# Gap check\n\nSkipped: no .bastion/requirement.md, so there was nothing to check the tests against.\n');
    }
  });
});

describe('v1.1 tests: critic failure fails closed', () => {
  const cases: Array<[string, RoleFixture]> = [
    ['non-zero exit', { exit: 1, output: { gaps: [] } }],
    ['no report written', {}],
    ['invalid report', { output: { gaps: 'none' } }],
  ];
  for (const [name, critic] of cases) {
    it(`${name}: returns 1, no lock, no test commit`, async () => {
      const repo = makeRepo(fixtures({ critic }));
      const before = git(['rev-parse', 'HEAD'], repo);
      const { result, err } = await captureConsole(() => runTests({ cwd: repo, lock: true }));
      assert.equal(result, 1);
      assert.match(err, /\[bastion\] tests: gap check failed: /);
      assert.equal(fs.existsSync(lockPath(repo)), false);
      assert.equal(git(['rev-parse', 'HEAD'], repo), before, 'nothing committed');
      assert.ok(!subjects(repo).includes('test(bastion): acceptance tests'));
      assert.equal(testerCalls(repo).length, 2, 'testers ran before the check');
      assert.equal(criticCalls(repo).length, 1);
    });
  }
});

describe('v1.1 tests: no gaps', () => {
  it('locks, writes gaps.md, commits it, and calls the critic exactly once after the testers', async () => {
    const repo = makeRepo(fixtures({ critic: report() }));
    const { result } = await captureConsole(() => runTests({ cwd: repo, lock: true }));
    assert.equal(result, 0);
    const calls = readRoleCalls(repo);
    assert.deepEqual(calls.map((c) => c.role), ['tester', 'tester', 'critic']);
    assert.equal(calls[2].label, 'gaps');
    assert.ok(fs.existsSync(lockPath(repo)));
    const md = gapsMd(repo);
    assert.match(md, /^# Gap check/);
    assert.match(md, /No gaps found\./);
    assert.ok(!/Patched by the tester/.test(md));
    assert.equal(git(['ls-files', '.bastion/gaps.md'], repo), '.bastion/gaps.md', 'gaps.md is committed');
    assert.equal(git(['status', '--porcelain'], repo), '', 'working tree is clean');
    assert.equal(fs.readFileSync(path.join(repo, ADD), 'utf8'), ORIG_ADD);
  });

  it('when every reported gap is discarded the gap check does not count: no patch, no lock (round 5)', async () => {
    const invented = { rule: 'add is commutative', quote: 'add must be commutative for all inputs', file: ADD };
    const repo = makeRepo(fixtures({ critic: report(invented), n1Gaps: STRONG_ADD }));
    const { result, err } = await captureConsole(() => runTests({ cwd: repo, lock: true }));
    assert.equal(result, 1);
    assert.match(err, /gap check failed.*none of them quotes the requirement/);
    assert.ok(!fs.existsSync(path.join(repo, '.bastion', 'lock.json')), 'nothing is locked');
    assert.equal(testerCalls(repo).length, 2);
    assert.equal(criticCalls(repo).length, 1);
    assert.equal(fs.readFileSync(path.join(repo, ADD), 'utf8'), ORIG_ADD);
  });
});

describe('v1.1 tests: kept gaps are patched by the tester', () => {
  it('one extra tester call for the affected node only, with rule, quote and the patch rules in the prompt', async () => {
    const repo = makeRepo(fixtures({ critic: report(GAP_MUL), n2Gaps: STRONG_MUL }));
    const { result } = await captureConsole(() => runTests({ cwd: repo, lock: true }));
    assert.equal(result, 0);
    assert.equal(criticCalls(repo).length, 1, 'critic runs once, no second pass');
    const testers = testerCalls(repo);
    assert.deepEqual(testers.map((c) => c.label).sort(), ['tests-n1', 'tests-n2', 'tests-n2-gaps']);
    const p = testers.find((c) => c.label === 'tests-n2-gaps')!.prompt;
    assert.ok(p.includes('## Original requirement (source of truth)') && p.includes(REQ_TEXT));
    assert.ok(p.includes(MARK), 'interfaces');
    assert.ok(p.includes('export function mul(a: number, b: number): number'), 'node interface');
    assert.ok(p.includes(MUL), 'path of the existing test file');
    assert.ok(p.includes(GAP_MUL.rule), 'rule');
    assert.ok(p.includes(Q_MUL), 'quote');
    assert.match(p, /not remove or weaken/i);
    assert.ok(!p.includes(ADD), 'the other node is not mentioned');
    // patched content is what got committed and locked
    assert.equal(fs.readFileSync(path.join(repo, MUL), 'utf8'), STRONG_MUL);
    assert.equal(git(['show', `HEAD:${MUL}`], repo).replace(/\r\n/g, '\n'), STRONG_MUL.trim()); // the git helper trims its output
    assert.ok(fs.existsSync(lockPath(repo)));
    assert.equal(git(['status', '--porcelain'], repo), '');
    // critic ran before the patch; patch calls come after
    const order = readRoleCalls(repo).map((c) => c.label);
    assert.ok(order.indexOf('gaps') < order.indexOf('tests-n2-gaps'));
    const md = gapsMd(repo);
    assert.match(md, /Patched by the tester: n2 \(1 new case\(s\)\)\. The patch was not re-checked by the critic\./);
    assert.ok(md.includes(GAP_MUL.rule) && md.includes(Q_MUL));
    assert.equal(git(['ls-files', '.bastion/gaps.md'], repo), '.bastion/gaps.md');
  });

  it('groups gaps by file (one call per node, sequential in map order) and lists both nodes in the note', async () => {
    const repo = makeRepo(
      fixtures({ critic: report(GAP_MUL, GAP_ADD, { ...GAP_ADD, rule: 'second add rule', quote: 'The calculator adds two numbers.' }), n1Gaps: STRONG_ADD, n2Gaps: STRONG_MUL })
    );
    const { result } = await captureConsole(() => runTests({ cwd: repo, lock: true }));
    assert.equal(result, 0);
    assert.equal(criticCalls(repo).length, 1);
    const labels = testerCalls(repo).map((c) => c.label);
    assert.equal(labels.filter((l) => l.endsWith('-gaps')).length, 2, 'exactly one call per affected node');
    assert.ok(labels.indexOf('tests-n1-gaps') < labels.indexOf('tests-n2-gaps'), 'sequential, map order');
    const p1 = testerCalls(repo).find((c) => c.label === 'tests-n1-gaps')!.prompt;
    const p2 = testerCalls(repo).find((c) => c.label === 'tests-n2-gaps')!.prompt;
    assert.ok(p1.includes(GAP_ADD.rule) && p1.includes('second add rule') && p1.includes(Q_ADD));
    assert.ok(!p1.includes(GAP_MUL.rule), 'n1 does not see the mul rule');
    assert.ok(p2.includes(GAP_MUL.rule) && !p2.includes(GAP_ADD.rule));
    assert.match(gapsMd(repo), /Patched by the tester: n1, n2 \(2 new case\(s\)\)\./);
    assert.equal(fs.readFileSync(path.join(repo, ADD), 'utf8'), STRONG_ADD);
    assert.equal(fs.readFileSync(path.join(repo, MUL), 'utf8'), STRONG_MUL);
  });

  it('compares gap.file with forward slashes', async () => {
    const repo = makeRepo(fixtures({ critic: report({ ...GAP_MUL, file: 'tests\\mul.test.mjs' }), n1Gaps: STRONG_ADD, n2Gaps: STRONG_MUL }));
    const { result } = await captureConsole(() => runTests({ cwd: repo, lock: true }));
    assert.equal(result, 0);
    const labels = testerCalls(repo).map((c) => c.label);
    assert.ok(labels.includes('tests-n2-gaps'));
    assert.ok(!labels.includes('tests-n1-gaps'));
  });

  it('a gap without file, or naming an unknown file, goes to the first node', async () => {
    const repo = makeRepo(
      fixtures({
        critic: report({ rule: 'mul rejects negatives', quote: Q_MUL }, { rule: 'add zero rule', quote: Q_ADD, file: 'tests/other.test.mjs' }),
        n1Gaps: STRONG_ADD,
        n2Gaps: STRONG_MUL,
      })
    );
    const { result } = await captureConsole(() => runTests({ cwd: repo, lock: true }));
    assert.equal(result, 0);
    const gapCalls = testerCalls(repo).filter((c) => c.label.endsWith('-gaps'));
    assert.deepEqual(gapCalls.map((c) => c.label), ['tests-n1-gaps']);
    assert.ok(gapCalls[0].prompt.includes('mul rejects negatives') && gapCalls[0].prompt.includes('add zero rule'));
    assert.match(gapsMd(repo), /Patched by the tester: n1 \(1 new case\(s\)\)\./);
  });

  it('only kept gaps are sent to the tester; discarded ones are not', async () => {
    const invented = { rule: 'INVENTED-RULE-XYZ', quote: 'the calculator must also divide', file: MUL };
    const repo = makeRepo(fixtures({ critic: report(GAP_MUL, invented), n2Gaps: STRONG_MUL }));
    const { result } = await captureConsole(() => runTests({ cwd: repo, lock: true }));
    assert.equal(result, 0);
    const p = testerCalls(repo).find((c) => c.label === 'tests-n2-gaps')!.prompt;
    assert.ok(p.includes(GAP_MUL.rule));
    assert.ok(!p.includes('INVENTED-RULE-XYZ'));
    assert.match(gapsMd(repo), /Discarded/);
  });
});

describe('v1.1 tests: a bad patch fails the run', () => {
  async function expectFailure(fx: Fx): Promise<{ repo: string; err: string }> {
    const repo = makeRepo(fixtures(fx));
    const before = git(['rev-parse', 'HEAD'], repo);
    const { result, err } = await captureConsole(() => runTests({ cwd: repo, lock: true }));
    assert.equal(result, 1);
    assert.ok(err.trim().length > 0, 'explains on stderr');
    assert.equal(fs.existsSync(lockPath(repo)), false);
    assert.equal(git(['rev-parse', 'HEAD'], repo), before, 'no test commit');
    assert.equal(criticCalls(repo).length, 1);
    return { repo, err };
  }

  it('unchanged file -> 1', async () => {
    const { repo, err } = await expectFailure({ critic: report(GAP_ADD), n1Gaps: ORIG_ADD });
    assert.ok(err.includes(`[bastion] tests: gap patch for n1 added no test case to ${ADD}.`));
    assert.ok(testerCalls(repo).some((c) => c.label === 'tests-n1-gaps'), 'the patch was attempted');
  });

  it('tester not touching the file at all -> 1', async () => {
    await expectFailure({ critic: report(GAP_ADD) });
  });

  it('file changed but with fewer test cases -> 1', async () => {
    assert.notEqual(FEWER_ADD, ORIG_ADD);
    await expectFailure({ critic: report(GAP_ADD), n1Gaps: FEWER_ADD });
  });

  it('patch tester exits non-zero even though it wrote a longer file -> 1', async () => {
    await expectFailure({ critic: report(GAP_ADD), n1Gaps: STRONG_ADD, n1GapsExit: 2 });
  });
});

describe('v1.1 tests: lock amend path still gap-checks', () => {
  it('an existing lock is amended after a gap patch', async () => {
    const repo = makeRepo(fixtures({ critic: report() }));
    assert.equal((await captureConsole(() => runTests({ cwd: repo, lock: true }))).result, 0);
    setFixtures(repo, fixtures({ critic: report(GAP_ADD), n1Gaps: STRONG_ADD }));
    const { result } = await captureConsole(() => runTests({ cwd: repo, lock: true }));
    assert.equal(result, 0);
    const lock = JSON.parse(fs.readFileSync(lockPath(repo), 'utf8')) as { amendments?: Array<{ reason: string }> };
    assert.equal(lock.amendments?.length, 1);
    assert.equal(lock.amendments?.[0].reason, 'bastion tests');
    assert.equal(fs.readFileSync(path.join(repo, ADD), 'utf8'), STRONG_ADD);
    assert.match(gapsMd(repo), /Patched by the tester: n1 \(1 new case\(s\)\)\./);
  });
});
