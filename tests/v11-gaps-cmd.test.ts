// v1.1 - gap check: findGaps + runGaps (src/commands/gaps.ts). The critic is the fake role script (tests/v1-helpers.ts).
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { findGaps, runGaps } from '../src/commands/gaps.js';
import { runLock } from '../src/commands/lock.js';
import { captureConsole, cleanupTempRepos, git, writeRepoFile } from './v04-helpers.js';
import { createRoleRepo, readRoleCalls } from './v1-helpers.js';
import type { RoleFixture, RoleFixtures } from './v1-helpers.js';

afterEach(cleanupTempRepos);

const REQ =
  'Add returns the sum of two numbers.\nMul returns the product of two numbers.\nNegative inputs are rejected with a RangeError.\n';

const ADD_TEST = [
  `import test from 'node:test';`,
  `import assert from 'node:assert/strict';`,
  `import { add } from '../src/add.mjs';`,
  `test('add basic', () => { const m = 'MARK_ADD_BASIC'; assert.equal(add(2, 3), 5); });`,
  `test('add zero', () => { const m = 'MARK_ADD_ZERO'; assert.equal(add(0, 0), 0); });`,
  ``,
].join('\n');
const MUL_TEST = [
  `import test from 'node:test';`,
  `import assert from 'node:assert/strict';`,
  `import { mul } from '../src/mul.mjs';`,
  `test('mul basic', () => { const m = 'MARK_MUL_BASIC'; assert.equal(mul(4, 5), 20); });`,
  `test('mul zero', () => { const m = 'MARK_MUL_ZERO'; assert.equal(mul(4, 0), 0); });`,
  `test('mul::neg', () => { const m = 'MARK_MUL_NEG'; assert.equal(mul(-1, 1), -1); });`,
  ``,
].join('\n');
const ADD = 'tests/add.test.mjs';
const MUL = 'tests/mul.test.mjs';

const GAP_A = { rule: 'Negative inputs must throw RangeError', quote: 'Negative inputs are rejected with a RangeError.', file: MUL };
const GAP_INVENTED = { rule: 'Division by zero returns Infinity', quote: 'Division by zero returns Infinity', file: ADD };

function critic(byLabel: Record<string, RoleFixture>): RoleFixtures {
  return { critic: { byLabel } };
}

interface Opts {
  fixtures: RoleFixtures;
  requirement?: string | null; // null = do not write
  /** v1.1: without a lock the gap check has no test files (default true: the repo is locked). */
  locked?: boolean;
  /** Runs after the lock (e.g. to delete or blank a locked test file). */
  afterLock?: (repo: string) => void;
}
function makeRepo(o: Opts): string {
  const repo = createRoleRepo({
    fixtures: o.fixtures,
    files: {
      'src/add.mjs': 'export function add(a, b) { return 0; }\n',
      'src/mul.mjs': 'export function mul(a, b) { return 0; }\n',
      'package.json': '{ "name": "calc", "description": "PKG_MARKER_GAPS" }\n',
      [ADD]: ADD_TEST,
      [MUL]: MUL_TEST,
      '.bastion/acceptance.md': '# Acceptance\n\nACCEPTANCE_MARKER_XYZ\n',
      ...(o.requirement === null ? {} : { '.bastion/requirement.md': o.requirement ?? REQ }),
    },
  });
  // v1.1: the default test files are the locked ones; there is no map.json and no plan.json at all.
  if (o.locked !== false) {
    assert.equal(runLock({ cwd: repo }), 0, 'fixture lock must succeed');
    git(['add', '.'], repo);
    git(['commit', '-m', 'chore: lock'], repo);
  }
  o.afterLock?.(repo);
  return repo;
}
const criticCalls = (repo: string) => readRoleCalls(repo).filter((c) => c.role === 'critic');
const read = (repo: string, rel: string) => fs.readFileSync(path.join(repo, rel), 'utf8');
const exists = (repo: string, rel: string) => fs.existsSync(path.join(repo, rel));

describe('findGaps normal mode', () => {
  it('sends only the requirement and the test files to the critic, and returns kept gaps', async () => {
    const repo = makeRepo({ fixtures: critic({ gaps: { output: { gaps: [GAP_A] } } }) });
    const r = await findGaps(repo);
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.kept, [GAP_A]);
    assert.deepEqual(r.discarded, []);
    const calls = criticCalls(repo);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].label, 'gaps');
    const p = calls[0].prompt;
    assert.ok(p.includes(REQ), 'requirement verbatim');
    assert.ok(p.includes(ADD_TEST) && p.includes(MUL_TEST), 'every test file verbatim');
    assert.ok(p.includes(`### ${ADD}`) && p.includes(`### ${MUL}`));
    assert.ok(!p.includes('ES modules under src/, one function per file.'), 'no interfaces text');
    assert.ok(!p.includes('Export add(a, b) returning the sum.'), 'no node summaries');
    assert.ok(!p.includes('ACCEPTANCE_MARKER_XYZ'), 'no acceptance.md');
    assert.ok(!p.includes('PKG_MARKER_GAPS') && !p.includes('package.json'), 'locked non-test paths (package.json) are left out');
    assert.ok(p.indexOf(`### ${ADD}`) < p.indexOf(`### ${MUL}`), 'lock order');
    assert.equal(exists(repo, '.bastion/map.json'), false, 'works without map.json');
  });

  it('splits gaps by quote: case/whitespace-insensitive match is kept, an invented quote is discarded', async () => {
    const fuzzy = { rule: 'Reject negatives', quote: 'negative  inputs are\n rejected with a RANGEERROR.' };
    const r = await findGaps(makeRepo({ fixtures: critic({ gaps: { output: { gaps: [GAP_INVENTED, fuzzy, GAP_A] } } }) }));
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.kept.map((g) => g.rule), ['Reject negatives', GAP_A.rule]);
    assert.deepEqual(r.discarded.map((g) => g.rule), [GAP_INVENTED.rule]);
  });

  it('cleans the report: trims rule/quote and drops an empty file', async () => {
    const raw = { gaps: [{ rule: '  Neg  ', quote: ' Negative inputs ', file: '', extra: 1 }], note: 'x' };
    const r = await findGaps(makeRepo({ fixtures: critic({ gaps: { output: raw } }) }));
    assert.equal(r.ok, true, r.error);
    assert.equal(r.kept.length, 1);
    assert.equal(r.kept[0].rule, 'Neg');
    assert.equal(r.kept[0].quote, 'Negative inputs');
    assert.equal(r.kept[0].file, undefined);
  });

  it('{"gaps":[]} is ok with nothing kept', async () => {
    const r = await findGaps(makeRepo({ fixtures: critic({ gaps: { output: { gaps: [] } } }) }));
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.kept, []);
    assert.deepEqual(r.discarded, []);
  });

  it('testFiles overrides the lock and skips files that do not exist', async () => {
    const repo = makeRepo({ fixtures: critic({ gaps: { output: { gaps: [] } } }) });
    const r = await findGaps(repo, { testFiles: [ADD, 'tests/ghost.test.mjs'] });
    assert.equal(r.ok, true, r.error);
    const p = criticCalls(repo)[0].prompt;
    assert.ok(p.includes(ADD_TEST));
    assert.ok(!p.includes('MARK_MUL_BASIC'));
    assert.ok(!p.includes('ghost'));
  });

  it('uses the locked test files, each once; a locked file that is gone from disk is skipped', async () => {
    const repo = makeRepo({
      fixtures: critic({ gaps: { output: { gaps: [] } } }),
      afterLock: (r) => fs.rmSync(path.join(r, MUL)),
    });
    const r = await findGaps(repo);
    assert.equal(r.ok, true, r.error);
    const p = criticCalls(repo)[0].prompt;
    assert.ok(p.includes(ADD_TEST));
    assert.ok(!p.includes('MARK_MUL_BASIC'));
    assert.equal(p.split(`### ${ADD}`).length, 2, 'file listed once');
  });
});

describe('findGaps fails closed', () => {
  const fx = critic({ gaps: { output: { gaps: [] } } });

  it('missing requirement -> !ok, critic never called', async () => {
    const repo = makeRepo({ fixtures: fx, requirement: null });
    const r = await findGaps(repo);
    assert.equal(r.ok, false);
    assert.ok(r.error);
    assert.equal(criticCalls(repo).length, 0);
  });

  it('blank requirement -> !ok', async () => {
    const repo = makeRepo({ fixtures: fx, requirement: ' \n\t\n' });
    assert.equal((await findGaps(repo)).ok, false);
    assert.equal(criticCalls(repo).length, 0);
  });

  it('no readable test file -> !ok, critic never called', async () => {
    const repo = makeRepo({ fixtures: fx, afterLock: (r) => { fs.rmSync(path.join(r, ADD)); fs.rmSync(path.join(r, MUL)); } });
    assert.equal((await findGaps(repo)).ok, false);
    assert.equal(criticCalls(repo).length, 0);
  });

  it('no lock.json -> !ok, critic never called, the error points at bastion lock (also through runGaps)', async () => {
    const repo = makeRepo({ fixtures: fx, locked: false });
    const r = await findGaps(repo);
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /lock/i);
    assert.equal(criticCalls(repo).length, 0);
    const cmd = await captureConsole(() => runGaps({ cwd: repo }));
    assert.equal(cmd.result, 1);
    assert.match(cmd.err, /lock/i);
    assert.equal(criticCalls(repo).length, 0);
  });

  it('critic exit 1 -> !ok even though it wrote an empty valid report', async () => {
    const repo = makeRepo({ fixtures: critic({ gaps: { output: { gaps: [] }, exit: 1 } }) });
    const r = await findGaps(repo);
    assert.equal(r.ok, false);
    assert.deepEqual(r.kept, []);
  });

  it('critic writes no report -> !ok, and an old report is not reused', async () => {
    const repo = makeRepo({ fixtures: critic({ gaps: {} }) });
    writeRepoFile(repo, '.bastion/gaps.json', JSON.stringify({ gaps: [] }));
    const r = await findGaps(repo);
    assert.equal(r.ok, false);
  });

  const invalid: Array<[string, RoleFixture]> = [
    ['not json', { files: { '.bastion/gaps.json': 'not json{' } }],
    ['no gaps key', { output: {} }],
    ['gaps not an array', { output: { gaps: 'none' } }],
    ['blank rule', { output: { gaps: [{ rule: '  ', quote: 'Add' }] } }],
    ['missing quote', { output: { gaps: [{ rule: 'r' }] } }],
  ];
  for (const [name, fixture] of invalid) {
    it(`invalid report (${name}) -> !ok`, async () => {
      const r = await findGaps(makeRepo({ fixtures: critic({ gaps: fixture }) }));
      assert.equal(r.ok, false);
      assert.deepEqual(r.kept, []);
    });
  }
});

const PROBE_GAPS = [
  { rule: 'First rule text', quote: 'Add returns the sum of two numbers.', file: ADD },
  GAP_INVENTED,
  { rule: 'Second rule text', quote: 'Mul returns the product', file: MUL },
];
function probeFixtures(judge?: RoleFixture, probe: RoleFixture = { output: { gaps: PROBE_GAPS } }): RoleFixtures {
  return critic({ gaps: { output: { gaps: [] } }, 'gaps-probe': probe, ...(judge ? { 'gaps-probe-judge': judge } : {}) });
}

describe('findGaps probe mode', () => {
  it('hides the middle case (index floor(count/2)) from the critic only; files stay byte-identical', async () => {
    const repo = makeRepo({ fixtures: probeFixtures({ output: { detected: true } }) });
    const r = await findGaps(repo, { probe: true });
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.probe, { file: MUL, name: 'mul basic', detected: true });
    const probeCalls = criticCalls(repo).filter((c) => c.label === 'gaps-probe');
    assert.equal(probeCalls.length, 1);
    assert.equal(criticCalls(repo).filter((c) => c.label === 'gaps').length, 0);
    const p = probeCalls[0].prompt;
    assert.ok(!p.includes('MARK_MUL_BASIC'), 'hidden case source absent');
    assert.ok(!p.includes("test('mul basic'"));
    for (const m of ['MARK_ADD_BASIC', 'MARK_ADD_ZERO', 'MARK_MUL_ZERO', 'MARK_MUL_NEG']) assert.ok(p.includes(m), m);
    assert.ok(p.includes(REQ));
    assert.equal(read(repo, MUL), MUL_TEST);
    assert.equal(read(repo, ADD), ADD_TEST);
    assert.equal(git(['status', '--porcelain', '--', 'tests'], repo), '');
    assert.deepEqual(r.kept.map((g) => g.rule), ['First rule text', 'Second rule text']);
    assert.deepEqual(r.discarded.map((g) => g.rule), [GAP_INVENTED.rule]);
  });

  it('judge prompt shows the removed source and only the numbered kept gaps; detected follows the judge', async () => {
    const repo = makeRepo({ fixtures: probeFixtures({ output: { detected: false } }) });
    const r = await findGaps(repo, { probe: true });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.probe?.detected, false);
    const judge = criticCalls(repo).filter((c) => c.label === 'gaps-probe-judge');
    assert.equal(judge.length, 1);
    const p = judge[0].prompt;
    assert.ok(p.includes('MARK_MUL_BASIC'));
    assert.match(p, /1[^\n]*First rule text/);
    assert.match(p, /2[^\n]*Second rule text/);
    assert.ok(!p.includes('Division by zero'), 'discarded gap not shown to the judge');
    assert.ok(p.includes('detected'));
    assert.deepEqual(criticCalls(repo).map((c) => c.label), ['gaps-probe', 'gaps-probe-judge']);
  });

  it('no kept gap -> detected false without a judge call (empty and all-discarded)', async () => {
    for (const gaps of [[], [GAP_INVENTED]]) {
      const repo = makeRepo({ fixtures: probeFixtures({ output: { detected: true } }, { output: { gaps } }) });
      const r = await findGaps(repo, { probe: true });
      assert.equal(r.ok, true, r.error);
      assert.equal(r.probe?.detected, false);
      assert.equal(criticCalls(repo).filter((c) => c.label === 'gaps-probe-judge').length, 0);
    }
  });

  it('drop picks the case; a case name containing "::" works; a missing file is not touched', async () => {
    const repo = makeRepo({ fixtures: probeFixtures({ output: { detected: true } }) });
    const r = await findGaps(repo, { probe: true, drop: `${MUL}::mul::neg` });
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.probe, { file: MUL, name: 'mul::neg', detected: true });
    const p = criticCalls(repo)[0].prompt;
    assert.ok(!p.includes('MARK_MUL_NEG'));
    assert.ok(p.includes('MARK_MUL_BASIC') && p.includes('MARK_ADD_ZERO'));
    const repo2 = makeRepo({ fixtures: probeFixtures({ output: { detected: true } }) });
    const r2 = await findGaps(repo2, { probe: true, drop: `${ADD}::add basic` });
    assert.deepEqual(r2.probe, { file: ADD, name: 'add basic', detected: true });
    assert.ok(!criticCalls(repo2)[0].prompt.includes('MARK_ADD_BASIC'));
  });

  for (const [name, drop] of [
    ['unknown file', 'tests/nope.test.mjs::add basic'],
    ['unknown case', `${ADD}::no such case`],
    ['case of another file', `${ADD}::mul basic`],
    ['no separator', 'add basic'],
  ] as const) {
    it(`bad drop (${name}) -> !ok without calling the critic`, async () => {
      const repo = makeRepo({ fixtures: probeFixtures({ output: { detected: true } }) });
      const r = await findGaps(repo, { probe: true, drop });
      assert.equal(r.ok, false);
      assert.ok(r.error);
      assert.equal(criticCalls(repo).length, 0);
    });
  }

  it('a suite with no test case at all -> !ok', async () => {
    const repo = makeRepo({
      fixtures: probeFixtures({ output: { detected: true } }),
      afterLock: (r) => { writeRepoFile(r, ADD, '// nothing\n'); writeRepoFile(r, MUL, '// nothing\n'); },
    });
    const r = await findGaps(repo, { probe: true });
    assert.equal(r.ok, false);
    assert.equal(criticCalls(repo).length, 0);
  });

  it('probe critic failure or invalid report -> !ok, no judge', async () => {
    for (const probe of [{ output: { gaps: PROBE_GAPS }, exit: 1 }, { output: { gaps: 5 } }, {}]) {
      const repo = makeRepo({ fixtures: probeFixtures({ output: { detected: true } }, probe) });
      assert.equal((await findGaps(repo, { probe: true })).ok, false);
      assert.equal(criticCalls(repo).filter((c) => c.label === 'gaps-probe-judge').length, 0);
    }
  });

  it('judge failure or invalid judge JSON -> !ok (never a silent "detected")', async () => {
    const bad: RoleFixture[] = [
      { output: { detected: true }, exit: 1 },
      { output: {} },
      { output: { detected: 'yes' } },
      { files: { '.bastion/gaps-probe-judge.json': 'nope' } },
      {},
    ];
    for (const judge of bad) {
      const r = await findGaps(makeRepo({ fixtures: probeFixtures(judge) }), { probe: true });
      assert.equal(r.ok, false, JSON.stringify(judge));
    }
  });
});

describe('runGaps', () => {
  it('prints each kept gap, writes gaps.md and returns 1', async () => {
    const repo = makeRepo({ fixtures: critic({ gaps: { output: { gaps: [GAP_A, GAP_INVENTED] } } }) });
    const { result, out } = await captureConsole(() => runGaps({ cwd: repo }));
    assert.equal(result, 1);
    assert.ok(out.includes(`[bastion] gaps: ${GAP_A.rule}`), out);
    assert.ok(!out.includes(`[bastion] gaps: ${GAP_INVENTED.rule}`));
    const md = read(repo, '.bastion/gaps.md');
    assert.ok(md.startsWith('# Gap check'));
    assert.ok(md.includes('Kept: 1  Discarded (quote not in requirement): 1'));
    assert.ok(md.includes(`- ${GAP_A.rule} (file: ${MUL})`));
    assert.ok(md.includes(`  > ${GAP_A.quote}`));
    assert.ok(md.includes('## Discarded') && md.includes(GAP_INVENTED.rule));
  });

  it('no gaps -> "none found", return 0, gaps.md says so', async () => {
    const repo = makeRepo({ fixtures: critic({ gaps: { output: { gaps: [] } } }) });
    const { result, out } = await captureConsole(() => runGaps({ cwd: repo }));
    assert.equal(result, 0);
    assert.ok(out.includes('[bastion] gaps: none found.'), out);
    const md = read(repo, '.bastion/gaps.md');
    assert.ok(md.includes('No gaps found.'));
    assert.ok(md.includes('Kept: 0  Discarded (quote not in requirement): 0'));
  });

  it('a report whose gaps are all discarded does not count as a clean pass (round 5)', async () => {
    const repo = makeRepo({ fixtures: critic({ gaps: { output: { gaps: [GAP_INVENTED] } } }) });
    const { result, out } = await captureConsole(() => runGaps({ cwd: repo }));
    assert.equal(result, 1);
    assert.ok(!out.includes('none found'), out);
  });

  it('fails closed with a message on stderr: missing requirement, critic failure', async () => {
    const a = makeRepo({ fixtures: critic({ gaps: { output: { gaps: [] } } }), requirement: null });
    const ra = await captureConsole(() => runGaps({ cwd: a }));
    assert.equal(ra.result, 1);
    assert.ok(ra.err.trim().length > 0);
    assert.ok(!ra.out.includes('none found'));
    const b = makeRepo({ fixtures: critic({ gaps: { exit: 1 } }) });
    const rb = await captureConsole(() => runGaps({ cwd: b }));
    assert.equal(rb.result, 1);
    assert.ok(!rb.out.includes('none found'));
    assert.ok(rb.err.trim().length > 0);
  });

  it('not a git repo or unreadable config -> 1 with stderr', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bastion-v11-nogit-'));
    try {
      const r = await captureConsole(() => runGaps({ cwd: dir }));
      assert.equal(r.result, 1);
      assert.ok(r.err.trim().length > 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    const repo = makeRepo({ fixtures: critic({ gaps: { output: { gaps: [] } } }) });
    fs.writeFileSync(path.join(repo, '.bastion', 'config.json'), '{ not json');
    const r2 = await captureConsole(() => runGaps({ cwd: repo }));
    assert.equal(r2.result, 1);
    assert.ok(r2.err.trim().length > 0);
    assert.equal(criticCalls(repo).length, 0);
  });

  it('probe detected -> 0, prints the detected line, does not write gaps.md', async () => {
    const repo = makeRepo({ fixtures: probeFixtures({ output: { detected: true } }) });
    const { result, out } = await captureConsole(() => runGaps({ cwd: repo, probe: true }));
    assert.equal(result, 0);
    assert.ok(out.includes(`[bastion] gaps: probe detected the hidden case "mul basic" (${MUL}).`), out);
    assert.ok(!exists(repo, '.bastion/gaps.md'));
  });

  it('probe missed -> 1, stderr has the MISSED line and the redundancy hint, no gaps.md', async () => {
    const repo = makeRepo({ fixtures: probeFixtures({ output: { detected: false } }) });
    const { result, err } = await captureConsole(() => runGaps({ cwd: repo, probe: true, drop: `${ADD}::add zero` }));
    assert.equal(result, 1);
    assert.ok(err.includes(`[bastion] gaps: probe MISSED the hidden case "add zero" (${ADD}).`), err);
    assert.match(err, /redundant/i);
    assert.ok(!exists(repo, '.bastion/gaps.md'));
  });

  it('probe with a bad drop -> 1 and stderr', async () => {
    const repo = makeRepo({ fixtures: probeFixtures({ output: { detected: true } }) });
    const { result, err } = await captureConsole(() => runGaps({ cwd: repo, probe: true, drop: `${ADD}::nope` }));
    assert.equal(result, 1);
    assert.ok(err.trim().length > 0);
    assert.ok(!exists(repo, '.bastion/gaps.md'));
  });
});
