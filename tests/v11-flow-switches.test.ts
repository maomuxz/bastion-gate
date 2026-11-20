// v1.1 - `bastion flow` presets and switches: tier choice, switch overrides, fixed-for-the-run state, split, approval.
// Everything is driven through the fake role script (tests/v1-helpers.ts); no model is ever called.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { runFlow } from '../src/commands/flow.js';
import { isMapApproved, runReview } from '../src/commands/review.js';
import type { BastionMap } from '../src/map.js';
import { captureConsole, cleanupTempRepos, readJson } from './v04-helpers.js';
import { createRoleRepo, readRoleCalls, sampleMap, SAMPLE_FILES, setFixtures, type RoleFixtures } from './v1-helpers.js';

afterEach(cleanupTempRepos);

const REQ = 'A tiny calculator with add and mul.';
const STATE = ['.bastion', 'flow-state.json'];

function qaFor(node: string): RoleFixtures['qa'] {
  return {
    output: { verdict: 'pass', findings: [], cases: [{ name: 'c1', rule: 'calculator works', node, command: 'node .bastion/qa-cases/c1.mjs' }] },
    files: { '.bastion/qa-cases/c1.mjs': 'process.exit(0);\n' },
  };
}

const CALC_TEST =
  `import test from 'node:test';\nimport assert from 'node:assert/strict';\n` +
  `import { add } from '../src/add.mjs';\nimport { mul } from '../src/mul.mjs';\n` +
  `test('calc', () => { assert.equal(add(2, 3), 5); assert.equal(mul(4, 5), 20); });\n`;

function villageFixtures(): RoleFixtures {
  return {
    planner: {
      byLabel: {
        contract: {
          files: { ...SAMPLE_FILES.stubs },
          output: {
            files: ['src/add.mjs', 'src/mul.mjs'],
            testFile: 'tests/calc.test.mjs',
            interface: 'add(a, b) and mul(a, b) exported from src/add.mjs and src/mul.mjs',
            acceptance: ['add(2, 3) is 5', 'mul(4, 5) is 20'],
          },
        },
      },
    },
    tester: { files: { 'tests/calc.test.mjs': CALC_TEST } },
    run: { byLabel: { 'all-nodes': { files: { ...SAMPLE_FILES.impl } } } },
    critic: { output: { gaps: [] } },
    qa: qaFor('village'),
  };
}

function subMap(): BastionMap {
  return {
    version: 1,
    requirement: 'Split Mul',
    interfaces: 'SUB-INTERFACES shared by the parts.',
    nodes: [
      { id: 'x', title: 'Loop', summary: 'Loop part.', files: ['src/mul/loop.mjs'], interface: 'export function loop(): void', acceptance: ['loops'], testFile: 'tests/mul-loop.test.mjs', testCommand: 'node --test tests/mul-loop.test.mjs' },
      { id: 'y', title: 'Wrap', summary: 'Wrap part.', files: ['src/mul/wrap.mjs'], dependsOn: ['x'], interface: 'export function wrap(): void', acceptance: ['wraps'], testFile: 'tests/mul-wrap.test.mjs', testCommand: 'node --test tests/mul-wrap.test.mjs' },
    ],
  };
}

function splitMap(): BastionMap {
  const m = sampleMap();
  m.nodes[1].split = true;
  return m;
}

/** A map-tier fixture set: planner/blind give `map` (and `sub` for the split labels), then the 1.0 stages. */
function mapFixtures(map: BastionMap = sampleMap(), withSub = false): RoleFixtures {
  const sub = (p: string): Record<string, { output: unknown }> => (withSub ? { [`split-n2-${p}`]: { output: subMap() } } : {});
  return {
    planner: { output: map, byLabel: { 'map-a': { output: map }, ...sub('map-a') } },
    blind: { output: map, byLabel: { 'map-b': { output: map }, ...sub('map-b') } },
    worker: { files: { ...SAMPLE_FILES.stubs } },
    tester: { files: { ...SAMPLE_FILES.tests } },
    run: {
      byLabel: {
        n1: { files: { 'src/add.mjs': SAMPLE_FILES.impl['src/add.mjs'] } },
        n2: { files: { 'src/mul.mjs': SAMPLE_FILES.impl['src/mul.mjs'] } },
      },
    },
    critic: { output: { gaps: [] } },
    qa: qaFor('n1'),
  };
}

const roles = (repo: string): string[] => readRoleCalls(repo).map((c) => c.role);
const count = (repo: string, role: string, label?: string): number =>
  readRoleCalls(repo).filter((c) => c.role === role && (label === undefined || c.label === label)).length;
const flowState = (repo: string): { tier?: string; switches?: Record<string, unknown>; stages?: string[] } =>
  readJson(path.join(repo, ...STATE));
function setConfigSwitches(repo: string, switches: unknown): void {
  const p = path.join(repo, '.bastion', 'config.json');
  fs.writeFileSync(p, JSON.stringify({ ...readJson<Record<string, unknown>>(p), switches }, null, 2) + '\n');
}

describe('v1.1 flow: village (default tier)', () => {
  it('one call, no approval stop, a contract instead of map+scaffold; tier line and the 4 hints are printed', async () => {
    const repo = createRoleRepo({ fixtures: villageFixtures() });
    const r = await captureConsole(() => runFlow({ cwd: repo, requirement: REQ }));
    assert.equal(r.result, 0, r.out + r.err);

    assert.equal(flowState(repo).tier, 'village');
    assert.ok(r.out.includes('[bastion] flow: tier village (map=off secondMap=off split=off crew=1 scaffold=off approval=off questions=off budget=off).'), r.out);
    const hints = r.out.split(/\r?\n/).filter((l) => l.startsWith('[bastion] flow: ') && !l.includes('tier village (') && /village|city|capital/.test(l));
    assert.ok(hints.length >= 4, `4 hint lines expected, got ${hints.length}: ${r.out}`);
    assert.ok(r.out.includes('bastion flow --tier <village|city|capital> "<requirement>"'));

    const calls = readRoleCalls(repo);
    assert.equal(count(repo, 'planner'), 1);
    assert.equal(count(repo, 'planner', 'contract'), 1);
    assert.equal(count(repo, 'blind'), 0, 'no second map');
    assert.equal(count(repo, 'worker'), 0, 'no scaffold call');
    assert.equal(count(repo, 'tester'), 1);
    assert.equal(count(repo, 'run'), 1);
    assert.equal(count(repo, 'run', 'all-nodes'), 1, 'one construction call over everything');
    assert.equal(count(repo, 'qa'), 1);
    assert.ok(calls.findIndex((c) => c.role === 'tester') < calls.findIndex((c) => c.role === 'run'));
    assert.equal(isMapApproved(repo), true);
    assert.ok(flowState(repo).stages?.includes('done'));
  });

  it('the hints are printed on the first call only; later calls still print the tier line', async () => {
    const repo = createRoleRepo({ fixtures: villageFixtures() });
    assert.equal((await captureConsole(() => runFlow({ cwd: repo, requirement: REQ }))).result, 0);
    const again = await captureConsole(() => runFlow({ cwd: repo }));
    assert.equal(again.result, 0);
    assert.ok(again.out.includes('[bastion] flow: tier village ('), again.out);
    assert.ok(!again.out.includes('bastion flow --tier <village|city|capital>'), 'no hints on a later call');
  });

  it('an explicit --tier village does not print the hints', async () => {
    const repo = createRoleRepo({ fixtures: villageFixtures() });
    const r = await captureConsole(() => runFlow({ cwd: repo, requirement: REQ, tier: 'village' }));
    assert.equal(r.result, 0, r.out + r.err);
    assert.ok(r.out.includes('[bastion] flow: tier village ('));
    assert.ok(!r.out.includes('bastion flow --tier <village|city|capital>'));
  });
});

describe('v1.1 flow: city', () => {
  it('one planner (no blind), stops for approval; after approve builds n1 before n2 with a scaffold', async () => {
    const repo = createRoleRepo({ fixtures: mapFixtures() });
    const first = await captureConsole(() => runFlow({ cwd: repo, requirement: REQ, tier: 'city' }));
    assert.equal(first.result, 2, first.out + first.err);
    assert.equal(count(repo, 'planner'), 1);
    assert.equal(count(repo, 'planner', 'map-a'), 1);
    assert.equal(count(repo, 'blind'), 0);
    assert.ok(first.out.includes('[bastion] flow: tier city (map=on secondMap=off split=off crew=1 scaffold=on approval=on questions=off budget=off).'), first.out);
    assert.ok(!first.out.includes('bastion flow --tier <village|city|capital>'), 'tier was given, so no hints');
    assert.deepEqual(roles(repo).filter((r) => r !== 'planner'), []);

    assert.equal(runReview({ cwd: repo, approve: true }), 0);
    const second = await captureConsole(() => runFlow({ cwd: repo }));
    assert.equal(second.result, 0, second.out + second.err);
    assert.equal(count(repo, 'worker'), 1, 'scaffold ran');
    const runLabels = readRoleCalls(repo).filter((c) => c.role === 'run').map((c) => c.label);
    assert.deepEqual(runLabels, ['n1', 'n2'], 'one block after another, in dependency order');
    assert.equal(count(repo, 'blind'), 0);
  });

  it('a split flag on a node is ignored in city (switch off)', async () => {
    const repo = createRoleRepo({ fixtures: mapFixtures(splitMap(), true) });
    const r = await captureConsole(() => runFlow({ cwd: repo, requirement: REQ, tier: 'city' }));
    assert.equal(r.result, 2, r.out + r.err);
    assert.deepEqual(readRoleCalls(repo).map((c) => c.label), ['map-a']);
  });

  it('switches { split: true } on city honours the flag', async () => {
    const repo = createRoleRepo({ fixtures: mapFixtures(splitMap(), true), configPatch: { switches: { split: true } } });
    const r = await captureConsole(() => runFlow({ cwd: repo, requirement: REQ, tier: 'city' }));
    assert.equal(r.result, 2, r.out + r.err);
    assert.deepEqual(readRoleCalls(repo).map((c) => c.label), ['map-a', 'split-n2-map-a']);
  });
});

describe('v1.1 flow: capital', () => {
  it('one planner by default (secondMap off), then the approval stop', async () => {
    const repo = createRoleRepo({ fixtures: mapFixtures() });
    const r = await captureConsole(() => runFlow({ cwd: repo, requirement: REQ, tier: 'capital' }));
    assert.equal(r.result, 2, r.out + r.err);
    assert.equal(count(repo, 'planner'), 1);
    assert.equal(count(repo, 'blind'), 0, 'secondMap is off in every preset');
    assert.ok(r.out.includes('secondMap=off'));
    assert.ok(r.out.includes('crew=config'), 'crew 0 prints as config');
    assert.equal(isMapApproved(repo), false);
  });

  it('switches { secondMap: true } calls planner and blind', async () => {
    const repo = createRoleRepo({ fixtures: mapFixtures(), configPatch: { switches: { secondMap: true } } });
    const r = await captureConsole(() => runFlow({ cwd: repo, requirement: REQ, tier: 'capital' }));
    assert.equal(r.result, 2, r.out + r.err);
    assert.equal(count(repo, 'planner', 'map-a'), 1);
    assert.equal(count(repo, 'blind', 'map-b'), 1);
    assert.ok(r.out.includes('secondMap=on'));
    assert.equal(flowState(repo).switches?.secondMap, true);
  });

  it('splits a node flagged split: true before the approval stop, in map order, with the same planner count', async () => {
    const repo = createRoleRepo({ fixtures: mapFixtures(splitMap(), true) });
    const r = await captureConsole(() => runFlow({ cwd: repo, requirement: REQ, tier: 'capital' }));
    assert.equal(r.result, 2, r.out + r.err);
    assert.deepEqual(readRoleCalls(repo).map((c) => c.label), ['map-a', 'split-n2-map-a']);
    const map = readJson<BastionMap>(path.join(repo, '.bastion', 'map.json'));
    assert.deepEqual(map.nodes.map((n) => n.id), ['n1', 'n2.x', 'n2.y']);
    assert.equal(isMapApproved(repo), false);
    assert.ok(!roles(repo).includes('worker'));
  });

  it('with secondMap on the split asks both planners', async () => {
    const repo = createRoleRepo({ fixtures: mapFixtures(splitMap(), true), configPatch: { switches: { secondMap: true } } });
    const r = await captureConsole(() => runFlow({ cwd: repo, requirement: REQ, tier: 'capital' }));
    assert.equal(r.result, 2, r.out + r.err);
    const labels = readRoleCalls(repo).map((c) => c.label);
    assert.ok(labels.includes('split-n2-map-a') && labels.includes('split-n2-map-b'), labels.join(','));
  });

  it('switches { split: false } leaves the flag alone', async () => {
    const repo = createRoleRepo({ fixtures: mapFixtures(splitMap(), true), configPatch: { switches: { split: false } } });
    const r = await captureConsole(() => runFlow({ cwd: repo, requirement: REQ, tier: 'capital' }));
    assert.equal(r.result, 2, r.out + r.err);
    assert.deepEqual(readRoleCalls(repo).map((c) => c.label), ['map-a']);
  });

  it('a failing split returns its code', async () => {
    const fx = mapFixtures(splitMap(), true);
    fx.planner = { output: splitMap(), byLabel: { 'map-a': { output: splitMap() }, 'split-n2-map-a': { exit: 1 } } };
    const repo = createRoleRepo({ fixtures: fx });
    const r = await captureConsole(() => runFlow({ cwd: repo, requirement: REQ, tier: 'capital' }));
    assert.equal(r.result, 1, r.out + r.err);
    assert.ok(!roles(repo).includes('worker'));
  });
});

describe('v1.1 flow: overrides', () => {
  it('city with approval: false approves itself and finishes in one call', async () => {
    const repo = createRoleRepo({ fixtures: mapFixtures(), configPatch: { switches: { approval: false } } });
    const r = await captureConsole(() => runFlow({ cwd: repo, requirement: REQ, tier: 'city' }));
    assert.equal(r.result, 0, r.out + r.err);
    assert.equal(isMapApproved(repo), true);
    assert.equal(count(repo, 'planner'), 1);
    assert.equal(count(repo, 'worker'), 1);
    assert.deepEqual(readRoleCalls(repo).filter((c) => c.role === 'run').map((c) => c.label), ['n1', 'n2']);
    assert.ok(r.out.includes('approval=off'));
  });

  // Dispute s4-flow (upheld): with the scaffold switched off nobody creates the interface files, so in a repo that does
  // not have them yet the tests can only be red through import errors and the lock rightly refuses them. The switch is
  // for repos where the files already exist; here we only check that the scaffold call is skipped and that the flow
  // stops at the lock instead of building against unlocked tests.
  it('scaffold: false skips the scaffold call; without existing interface files the flow stops at the lock', async () => {
    const repo = createRoleRepo({ fixtures: mapFixtures(), configPatch: { switches: { approval: false, scaffold: false } } });
    const r = await captureConsole(() => runFlow({ cwd: repo, requirement: REQ, tier: 'city' }));
    assert.notEqual(r.result, 0, r.out + r.err);
    assert.equal(count(repo, 'worker'), 0, 'no scaffold call');
    assert.equal(count(repo, 'planner'), 1);
    assert.equal(count(repo, 'run'), 0, 'nothing is built against tests that could not be locked');
  });

  const bad: Array<[string, unknown, string, 'village' | 'city']> = [
    ['an unknown key', { bogusSwitch: true }, 'bogusSwitch', 'city'],
    ['map false with crew 2', { map: false, crew: 2 }, 'crew', 'village'],
    ['a non-boolean value', { approval: 'no' }, 'approval', 'city'],
    ['a negative crew', { crew: -1 }, 'crew', 'city'],
    ['map false on a preset that scaffolds', { map: false }, 'map', 'city'],
  ];
  for (const [name, switches, key, tier] of bad) {
    it(`${name} returns 1 with the error and no role call`, async () => {
      const repo = createRoleRepo({ fixtures: mapFixtures(), configPatch: { switches } });
      const r = await captureConsole(() => runFlow({ cwd: repo, requirement: REQ, tier }));
      assert.equal(r.result, 1);
      assert.ok(r.err.includes('[bastion] flow: '), r.err);
      assert.ok(r.err.includes(key), `error names ${key}: ${r.err}`);
      assert.deepEqual(readRoleCalls(repo), []);
    });
  }
});

describe('v1.1 flow: fixed for the run', () => {
  it('stores tier and switches in flow-state.json', async () => {
    const repo = createRoleRepo({ fixtures: mapFixtures(), configPatch: { switches: { secondMap: true } } });
    await captureConsole(() => runFlow({ cwd: repo, requirement: REQ, tier: 'city' }));
    const st = flowState(repo);
    assert.equal(st.tier, 'city');
    assert.deepEqual(st.switches, { map: true, secondMap: true, split: false, crew: 1, scaffold: true, approval: true, questions: false, budget: false });
    assert.ok(st.stages?.includes('map'));
  });

  it('changing config.switches after the first call changes nothing', async () => {
    const repo = createRoleRepo({ fixtures: mapFixtures() });
    assert.equal((await captureConsole(() => runFlow({ cwd: repo, requirement: REQ, tier: 'city' }))).result, 2);
    setConfigSwitches(repo, { approval: false, scaffold: false, bogus: 1 }); // would even be invalid now
    const again = await captureConsole(() => runFlow({ cwd: repo }));
    assert.equal(again.result, 2, 'still waits for approval: the stored switches rule');
    assert.ok(again.out.includes('tier city (map=on'), again.out);
    assert.equal(runReview({ cwd: repo, approve: true }), 0);
    const done = await captureConsole(() => runFlow({ cwd: repo }));
    assert.equal(done.result, 0, done.out + done.err);
    assert.equal(count(repo, 'worker'), 1, 'scaffold still on');
  });

  it('a different --tier later returns 1 with the chooseTier error and no role call', async () => {
    const repo = createRoleRepo({ fixtures: mapFixtures() });
    assert.equal((await captureConsole(() => runFlow({ cwd: repo, requirement: REQ, tier: 'city' }))).result, 2);
    const before = readRoleCalls(repo).length;
    const r = await captureConsole(() => runFlow({ cwd: repo, tier: 'capital' }));
    assert.equal(r.result, 1);
    assert.match(r.err, /city/);
    assert.match(r.err, /capital/);
    assert.match(r.err, /bastion clean --runs/);
    assert.equal(readRoleCalls(repo).length, before);
    assert.equal(flowState(repo).tier, 'city', 'state untouched');
    // the same tier again is fine
    assert.equal((await captureConsole(() => runFlow({ cwd: repo, tier: 'city' }))).result, 2);
  });

  it('also when the flow is already done', async () => {
    const repo = createRoleRepo({ fixtures: villageFixtures() });
    assert.equal((await captureConsole(() => runFlow({ cwd: repo, requirement: REQ }))).result, 0);
    const before = readRoleCalls(repo).length;
    const r = await captureConsole(() => runFlow({ cwd: repo, tier: 'city' }));
    assert.equal(r.result, 1);
    assert.match(r.err, /village/);
    assert.match(r.err, /city/);
    assert.equal(readRoleCalls(repo).length, before);
    assert.equal((await captureConsole(() => runFlow({ cwd: repo, tier: 'village' }))).result, 0);
  });

  it('a v1.0 state file { stages: [map] } counts as capital with secondMap on', async () => {
    const repo = createRoleRepo({ fixtures: mapFixtures(), configPatch: { switches: { secondMap: true } } });
    assert.equal((await captureConsole(() => runFlow({ cwd: repo, requirement: REQ, tier: 'capital' }))).result, 2);
    fs.writeFileSync(path.join(repo, ...STATE), JSON.stringify({ stages: ['map'] }));
    setConfigSwitches(repo, undefined);
    const r = await captureConsole(() => runFlow({ cwd: repo }));
    assert.equal(r.result, 2, r.out + r.err);
    assert.ok(r.out.includes('tier capital (') && r.out.includes('secondMap=on'), r.out);
    const st = flowState(repo);
    assert.equal(st.tier, 'capital');
    assert.equal(st.switches?.secondMap, true);
    assert.equal(st.switches?.approval, true);
    // and a conflicting tier is refused
    assert.equal((await captureConsole(() => runFlow({ cwd: repo, tier: 'village' }))).result, 1);
  });

  it('a v1.0 state file { stages: [] } counts as nothing recorded', async () => {
    const repo = createRoleRepo({ fixtures: villageFixtures() });
    fs.mkdirSync(path.join(repo, '.bastion'), { recursive: true });
    fs.writeFileSync(path.join(repo, ...STATE), JSON.stringify({ stages: [] }));
    const r = await captureConsole(() => runFlow({ cwd: repo, requirement: REQ }));
    assert.equal(r.result, 0, r.out + r.err);
    assert.equal(flowState(repo).tier, 'village');
    assert.ok(r.out.includes('bastion flow --tier <village|city|capital>'), 'defaulted, so the hints are printed');
  });

  it('a v1.0 state file with no stages accepts any --tier', async () => {
    const repo = createRoleRepo({ fixtures: mapFixtures() });
    fs.mkdirSync(path.join(repo, '.bastion'), { recursive: true });
    fs.writeFileSync(path.join(repo, ...STATE), JSON.stringify({ stages: [] }));
    const r = await captureConsole(() => runFlow({ cwd: repo, requirement: REQ, tier: 'city' }));
    assert.equal(r.result, 2, r.out + r.err);
    assert.equal(flowState(repo).tier, 'city');
  });
});
