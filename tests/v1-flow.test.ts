// v1.0 P8 - `bastion flow`: the resumable four-appearance command (requirement -> review -> swarm/qa -> done).
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { runFlow } from '../src/commands/flow.js';
import { runReview } from '../src/commands/review.js';
import { isMapApproved } from '../src/commands/review.js';
import { captureConsole, cleanupTempRepos, git, readRunStateFile } from './v04-helpers.js';
import { createRoleRepo, readRoleCalls, sampleMap, SAMPLE_FILES, setFixtures, type RoleFixtures } from './v1-helpers.js';

afterEach(cleanupTempRepos);

// v1.1: the v1.0 flow is the capital preset with secondMap on.
const V10 = { switches: { secondMap: true } };
const REQ = 'A tiny calculator with add and mul.';

const FLOW_CASE = { name: 'c1', rule: 'calculator works', node: 'n1', command: 'node .bastion/qa-cases/c1.mjs' };
function happyFixtures(qa: unknown = { verdict: 'pass', findings: [], cases: [FLOW_CASE] }): RoleFixtures {
  return {
    planner: { output: sampleMap() },
    blind: { output: sampleMap() },
    worker: { files: { ...SAMPLE_FILES.stubs } },
    tester: { files: { ...SAMPLE_FILES.tests } },
    run: {
      byLabel: {
        n1: { files: { 'src/add.mjs': SAMPLE_FILES.impl['src/add.mjs'] } },
        n2: { files: { 'src/mul.mjs': SAMPLE_FILES.impl['src/mul.mjs'] } },
      },
    },
    critic: { output: { gaps: [] } },
    qa: { output: qa, files: { '.bastion/qa-cases/c1.mjs': 'process.exit(0);\n' } },
  };
}

function completed(repo: string): string[] {
  return ((readRunStateFile(repo).completedNodes as string[]) ?? []).slice().sort();
}

describe('v1.0 flow', () => {
  it('walks requirement -> review -> swarm -> qa -> done across three invocations', async () => {
    const repo = createRoleRepo({ fixtures: happyFixtures(), configPatch: V10 });

    // 1) requirement: map is produced, brief printed, waiting for the human.
    const first = await captureConsole(() => runFlow({ cwd: repo, requirement: REQ, tier: 'capital' }));
    assert.equal(first.result, 2);
    assert.ok(fs.existsSync(path.join(repo, '.bastion', 'brief.md')), 'brief written');
    assert.ok(first.out.includes('bastion review --approve'), 'tells the human how to approve');
    assert.equal(isMapApproved(repo), false);
    assert.deepEqual(readRoleCalls(repo).map((c) => c.role).filter((r) => r !== 'planner' && r !== 'blind'), [], 'nothing built before approval');
    assert.ok(fs.existsSync(path.join(repo, '.bastion', 'flow-state.json')), 'flow state persisted');

    // 2) not approved yet: still waiting, and no stage after the map ran.
    const callsBefore = readRoleCalls(repo).length;
    const second = await captureConsole(() => runFlow({ cwd: repo, tier: 'capital' }));
    assert.equal(second.result, 2);
    assert.equal(readRoleCalls(repo).length, callsBefore, 'no new role calls while unapproved');
    assert.ok(second.out.length > 0, 'brief is printed again');

    // 3) approve, then flow builds everything.
    assert.equal(runReview({ cwd: repo, approve: true }), 0);
    assert.equal(isMapApproved(repo), true);
    const third = await captureConsole(() => runFlow({ cwd: repo, tier: 'capital' }));
    assert.equal(third.result, 0, third.out + third.err);

    const calls = readRoleCalls(repo);
    const roles = calls.map((c) => c.role);
    const firstIdx = (r: string) => roles.indexOf(r);
    assert.ok(firstIdx('worker') > -1 && firstIdx('tester') > firstIdx('worker'), 'scaffold before tests');
    assert.ok(firstIdx('run') > firstIdx('tester'), 'swarm after tests');
    assert.ok(firstIdx('qa') > roles.lastIndexOf('run'), 'qa after the swarm');
    assert.deepEqual(calls.filter((c) => c.role === 'run').map((c) => c.label).sort(), ['n1', 'n2']);
    assert.equal(roles.filter((r) => r === 'qa').length, 1, 'qa passed on the first try');

    assert.deepEqual(completed(repo), ['n1', 'n2']);
    const integration = readRunStateFile(repo).integrationBranch as string;
    assert.ok(integration, 'integration branch recorded');
    assert.ok(third.out.includes(integration), 'prints the integration branch to merge');
    assert.match(third.out, /merge/i);
    assert.match(third.out, /2\/2/, 'summary shows 2/2 nodes');
    assert.equal(git(['show', `${integration}:src/mul.mjs`], repo), SAMPLE_FILES.impl['src/mul.mjs'].trimEnd());
  });

  it('resuming after done returns 0 without any new role call', async () => {
    const repo = createRoleRepo({ fixtures: happyFixtures(), configPatch: V10 });
    assert.equal((await captureConsole(() => runFlow({ cwd: repo, requirement: REQ, tier: 'capital' }))).result, 2);
    assert.equal(runReview({ cwd: repo, approve: true }), 0);
    assert.equal((await captureConsole(() => runFlow({ cwd: repo, tier: 'capital' }))).result, 0);

    const before = readRoleCalls(repo).length;
    const again = await captureConsole(() => runFlow({ cwd: repo, tier: 'capital' }));
    assert.equal(again.result, 0);
    assert.equal(readRoleCalls(repo).length, before, 'no stage re-run');
    assert.match(again.out, /merge/i, 'still prints the merge instruction');
    assert.deepEqual(completed(repo), ['n1', 'n2']);
  });

  it('a failing planner stage returns its non-zero code and leaves nothing approved', async () => {
    const fixtures = happyFixtures();
    fixtures.planner = { exit: 1 };
    const repo = createRoleRepo({ fixtures, configPatch: V10 });
    const r = await captureConsole(() => runFlow({ cwd: repo, requirement: REQ, tier: 'capital' }));
    assert.equal(r.result, 1);
    assert.ok(readRoleCalls(repo).some((c) => c.role === 'planner'), 'the planner stage was actually attempted');
    assert.equal(isMapApproved(repo), false);
    assert.ok(!readRoleCalls(repo).some((c) => c.role === 'worker' || c.role === 'run'));
  });

  it('a failed stage is not recorded as finished: fixing it and re-running continues', async () => {
    const fixtures = happyFixtures();
    fixtures.planner = { exit: 1 };
    const repo = createRoleRepo({ fixtures, configPatch: V10 });
    assert.equal((await captureConsole(() => runFlow({ cwd: repo, requirement: REQ, tier: 'capital' }))).result, 1);
    setFixtures(repo, happyFixtures());
    assert.equal((await captureConsole(() => runFlow({ cwd: repo, requirement: REQ, tier: 'capital' }))).result, 2);
    assert.equal(runReview({ cwd: repo, approve: true }), 0);
    assert.equal((await captureConsole(() => runFlow({ cwd: repo, tier: 'capital' }))).result, 0);
    assert.deepEqual(completed(repo), ['n1', 'n2']);
  });

  it('qa fail triggers exactly one resumed swarm and one more qa, then stops with a non-zero code', async () => {
    const failing = { verdict: 'fail', findings: [{ node: 'n1', kind: 'code', issue: 'add is wrong' }], cases: [FLOW_CASE] };
    const repo = createRoleRepo({ fixtures: happyFixtures(failing), configPatch: V10 });
    assert.equal((await captureConsole(() => runFlow({ cwd: repo, requirement: REQ, tier: 'capital' }))).result, 2);
    assert.equal(runReview({ cwd: repo, approve: true }), 0);
    const r = await captureConsole(() => runFlow({ cwd: repo, tier: 'capital' }));
    assert.notEqual(r.result, 0, 'a persistently failing qa is not "done"');
    const roles = readRoleCalls(repo).map((c) => c.role);
    assert.equal(roles.filter((x) => x === 'qa').length, 2, 'qa, one resumed swarm, qa again - no loop');
    assert.ok(roles.indexOf('qa') < roles.lastIndexOf('qa'));
    assert.ok(!/merge/i.test(r.out) || !r.out.includes('bastion/run'), 'no merge instruction on failure');
  });
});
