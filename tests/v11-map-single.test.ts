// v1.1 - `bastion map` with planners: 1 (city tier, no blind map).
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { runMap } from '../src/commands/map.js';
import { BastionMap, validateMap } from '../src/map.js';
import { captureConsole, cleanupTempRepos, readJson, writeRepoFile } from './v04-helpers.js';
import { createRoleRepo, readRoleCalls, RoleFixtures, sampleMap, setFixtures } from './v1-helpers.js';

afterEach(cleanupTempRepos);

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const exists = (repo: string, rel: string): boolean => fs.existsSync(path.join(repo, rel));
const read = (repo: string, rel: string): string => fs.readFileSync(path.join(repo, rel), 'utf8');
const REQ = 'Build a tiny calculator CLI with add and mul.';
const SINGLE_DIFF = '# Map diff\n\nSingle map (city tier): no second map to compare.\n';
const INVALID = { version: 1, requirement: 'x', interfaces: '', nodes: [] };

function plannerMap(): BastionMap {
  const m = clone(sampleMap());
  m.interfaces = 'PLANNER-ONLY-MARKER shared contract.';
  return m;
}

function blindMap(): BastionMap {
  const m = clone(sampleMap());
  m.nodes[1].dependsOn = [];
  m.nodes[1].files.push('src/extra.mjs');
  return m;
}

function fixtures(planner: unknown, blind: unknown): RoleFixtures {
  return { planner: { output: planner }, blind: { output: blind } };
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

describe('v1.1 map planners:1', () => {
  it('calls only the planner, writes no map-b.json, exact single-map diff and all usual outputs', async () => {
    const repo = createRoleRepo({ fixtures: fixtures(plannerMap(), blindMap()) });
    writeRepoFile(repo, '.bastion/approval.json', '{"approved":true}');
    const { result } = await captureConsole(() => runMap({ cwd: repo, requirement: REQ, planners: 1 }));
    assert.equal(result, 0);

    const calls = readRoleCalls(repo);
    assert.equal(calls.length, 1, 'only one role call');
    assert.equal(calls[0].role, 'planner');
    assert.equal(calls[0].label, 'map-a');
    assert.match(calls[0].prompt, /tiny calculator CLI/);

    assert.ok(exists(repo, '.bastion/maps/map-a.json'));
    assert.equal(exists(repo, '.bastion/maps/map-b.json'), false, 'no map-b.json');
    assert.equal(read(repo, '.bastion/map-diff.md'), SINGLE_DIFF);

    assert.match(read(repo, '.bastion/requirement.md'), /tiny calculator CLI/);
    const map = readJson<BastionMap>(path.join(repo, '.bastion/map.json'));
    assert.equal(map.interfaces, 'PLANNER-ONLY-MARKER shared contract.');
    assert.deepEqual(map.nodes.map((n) => n.id), ['n1', 'n2']);
    assert.deepEqual(map.nodes[0].dependsOn, []);
    assert.match(read(repo, '.bastion/interfaces.md'), /## n1 Add/);
    assert.match(read(repo, '.bastion/acceptance.md'), /- mul\(4, 5\) is 20/);
    const plan = readJson<{ nodes: Array<{ id: string; dependsOn?: string[] }> }>(path.join(repo, '.bastion/plan.json'));
    assert.deepEqual(plan.nodes.map((n) => n.id), ['n1', 'n2']);
    assert.deepEqual(plan.nodes[1].dependsOn, ['n1']);
    assert.equal(exists(repo, '.bastion/approval.json'), false, 'stale approval removed');
  });

  it('replaces a stale map-b.json / map-diff.md from an earlier two-planner run', async () => {
    const repo = createRoleRepo({ fixtures: fixtures(sampleMap(), blindMap()) });
    assert.equal((await captureConsole(() => runMap({ cwd: repo, requirement: REQ }))).result, 0);
    assert.notEqual(read(repo, '.bastion/map-diff.md'), SINGLE_DIFF);
    const before = readRoleCalls(repo).length;
    const { result } = await captureConsole(() => runMap({ cwd: repo, requirement: REQ, planners: 1 }));
    assert.equal(result, 0);
    assert.equal(readRoleCalls(repo).length - before, 1);
    assert.equal(read(repo, '.bastion/map-diff.md'), SINGLE_DIFF);
  });

  it('works when no blind command differs: blind role fixture absent is never needed', async () => {
    const repo = createRoleRepo({ fixtures: { planner: { output: sampleMap() } } });
    const { result } = await captureConsole(() => runMap({ cwd: repo, requirement: REQ, planners: 1 }));
    assert.equal(result, 0);
    assert.equal(read(repo, '.bastion/map-diff.md'), SINGLE_DIFF);
    assert.equal(readRoleCalls(repo).length, 1);
  });

  it('invalid planner map still -> 1 with errors printed and no outputs', async () => {
    const repo = createRoleRepo({ fixtures: fixtures(INVALID, sampleMap()) });
    writeRepoFile(repo, '.bastion/approval.json', '{"approved":true}');
    const { result, out, err } = await captureConsole(() => runMap({ cwd: repo, requirement: REQ, planners: 1 }));
    assert.equal(result, 1);
    const printed = out + '\n' + err;
    for (const e of (validateMap(INVALID) as { errors: string[] }).errors) assert.ok(printed.includes(e), `missing error: ${e}`);
    for (const rel of ['map.json', 'map-diff.md', 'interfaces.md', 'acceptance.md', 'plan.json']) {
      assert.equal(exists(repo, `.bastion/${rel}`), false, rel);
    }
    assert.ok(exists(repo, '.bastion/approval.json'));
    assert.equal(readRoleCalls(repo).length, 1, 'blind is not called even on failure');
  });

  it('planner that writes no output -> 1 after a single call', async () => {
    const repo = createRoleRepo({ fixtures: { planner: {}, blind: { output: sampleMap() } } });
    const { result } = await captureConsole(() => runMap({ cwd: repo, requirement: REQ, planners: 1 }));
    assert.equal(result, 1);
    assert.equal(readRoleCalls(repo).length, 1);
    assert.equal(exists(repo, '.bastion/map.json'), false);
  });

  it('splitting with parent + planners:1 calls exactly one role and splits the node', async () => {
    const repo = createRoleRepo({ fixtures: fixtures(sampleMap(), sampleMap()) });
    await captureConsole(() => runMap({ cwd: repo, requirement: REQ }));
    const before = readRoleCalls(repo).length;
    setFixtures(repo, fixtures(subMap(), subMap()));
    const { result } = await captureConsole(() => runMap({ cwd: repo, parent: 'n2', planners: 1 }));
    assert.equal(result, 0);
    const calls = readRoleCalls(repo).slice(before);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].role, 'planner');
    assert.match(calls[0].prompt, /Mul/);
    const map = readJson<BastionMap>(path.join(repo, '.bastion/map.json'));
    assert.deepEqual(map.nodes.map((n) => n.id), ['n1', 'n2.x', 'n2.y']);
    assert.deepEqual(map.nodes[1].dependsOn, ['n1']);
    assert.match(read(repo, '.bastion/interfaces.md'), /## n2\.y Wrap/);
  });

  it('split with an invalid sub-map and planners:1 -> 1, map.json unchanged', async () => {
    const repo = createRoleRepo({ fixtures: fixtures(sampleMap(), sampleMap()) });
    await captureConsole(() => runMap({ cwd: repo, requirement: REQ }));
    const mapBefore = read(repo, '.bastion/map.json');
    const before = readRoleCalls(repo).length;
    setFixtures(repo, fixtures(INVALID, subMap()));
    const { result } = await captureConsole(() => runMap({ cwd: repo, parent: 'n2', planners: 1 }));
    assert.equal(result, 1);
    assert.equal(read(repo, '.bastion/map.json'), mapBefore);
    assert.equal(readRoleCalls(repo).length - before, 1);
  });
});

describe('v1.1 map planners:2 / undefined keep v1.0 behaviour', () => {
  for (const planners of [2, undefined] as const) {
    it(`planners ${String(planners)}: both roles called and the old diff is written`, async () => {
      const repo = createRoleRepo({ fixtures: fixtures(sampleMap(), blindMap()) });
      const { result } = await captureConsole(() => runMap({ cwd: repo, requirement: REQ, ...(planners ? { planners } : {}) }));
      assert.equal(result, 0);
      const calls = readRoleCalls(repo);
      assert.deepEqual(calls.map((c) => c.label).sort(), ['map-a', 'map-b']);
      assert.ok(exists(repo, '.bastion/maps/map-b.json'));
      const diff = read(repo, '.bastion/map-diff.md');
      assert.notEqual(diff, SINGLE_DIFF);
      assert.match(diff, /Dependencies/);
      assert.match(diff, /src\/extra\.mjs/);
    });
  }

  it('planners 2 with parent calls both roles', async () => {
    const repo = createRoleRepo({ fixtures: fixtures(sampleMap(), sampleMap()) });
    await captureConsole(() => runMap({ cwd: repo, requirement: REQ }));
    const before = readRoleCalls(repo).length;
    setFixtures(repo, fixtures(subMap(), subMap()));
    const { result } = await captureConsole(() => runMap({ cwd: repo, parent: 'n2', planners: 2 }));
    assert.equal(result, 0);
    assert.deepEqual(readRoleCalls(repo).slice(before).map((c) => c.role).sort(), ['blind', 'planner']);
  });
});
