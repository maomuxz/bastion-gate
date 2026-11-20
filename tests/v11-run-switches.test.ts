// v1.1 - runSwarm switches: questions:false (BASTION_QUESTIONS=off) and budget:false.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { EXIT_BUDGET, runSwarm } from '../src/commands/run.js';
import { AGENT_PRELUDE, captureConsole, cleanupTempRepos, createSwarmRepo, readRunStateFile } from './v04-helpers.js';

afterEach(cleanupTempRepos);

/** Agent that records whether BASTION_QUESTIONS is set (and its value) into .bastion/envseen-<id>.json in the main repo. */
const ENV_AGENT = [
  AGENT_PRELUDE,
  `fs.writeFileSync(process.env.BASTION_HOME + '/.bastion/envseen-' + id + '.json', JSON.stringify({ has: 'BASTION_QUESTIONS' in process.env, value: process.env.BASTION_QUESTIONS ?? null }));`,
  `implementNode();`,
].join('\n');

function seen(repo: string, id: string): { has: boolean; value: string | null } {
  return JSON.parse(fs.readFileSync(path.join(repo, '.bastion', `envseen-${id}.json`), 'utf8'));
}

async function withParentEnv<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.BASTION_QUESTIONS;
  if (value === undefined) delete process.env.BASTION_QUESTIONS;
  else process.env.BASTION_QUESTIONS = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.BASTION_QUESTIONS;
    else process.env.BASTION_QUESTIONS = prev;
  }
}

function runWith(repo: string, extra: Record<string, unknown>) {
  return captureConsole(() =>
    runSwarm({ cwd: repo, baseRef: 'main', agentCommand: 'node scripts/agent.mjs', concurrency: 1, maxRetries: 0, ...extra })
  );
}

describe('v1.1 run questions switch', () => {
  it('questions:false -> every agent sees BASTION_QUESTIONS === "off" (parent unset)', async () => {
    const repo = createSwarmRepo({ nodes: [{ id: 'qa' }, { id: 'qb' }], agentScript: ENV_AGENT });
    const { result } = await withParentEnv(undefined, () => runWith(repo, { questions: false }));
    assert.equal(result, 0);
    for (const id of ['qa', 'qb']) assert.deepEqual(seen(repo, id), { has: true, value: 'off' }, id);
  });

  it('questions:false overrides a different inherited value', async () => {
    const repo = createSwarmRepo({ nodes: [{ id: 'qa' }], agentScript: ENV_AGENT });
    const { result } = await withParentEnv('on', () => runWith(repo, { questions: false }));
    assert.equal(result, 0);
    assert.deepEqual(seen(repo, 'qa'), { has: true, value: 'off' });
  });

  for (const q of [undefined, true] as const) {
    it(`questions ${String(q)}: the variable is not set even if the parent had "off"`, async () => {
      const repo = createSwarmRepo({ nodes: [{ id: 'qa' }], agentScript: ENV_AGENT });
      const { result } = await withParentEnv('off', () => runWith(repo, q === undefined ? {} : { questions: q }));
      assert.equal(result, 0);
      assert.deepEqual(seen(repo, 'qa'), { has: false, value: null });
    });

    it(`questions ${String(q)}: the variable is not set when the parent has nothing`, async () => {
      const repo = createSwarmRepo({ nodes: [{ id: 'qa' }], agentScript: ENV_AGENT });
      const { result } = await withParentEnv(undefined, () => runWith(repo, q === undefined ? {} : { questions: q }));
      assert.equal(result, 0);
      assert.deepEqual(seen(repo, 'qa'), { has: false, value: null });
    });
  }

  it('the parent process env is restored / untouched by the run', async () => {
    const repo = createSwarmRepo({ nodes: [{ id: 'qa' }], agentScript: ENV_AGENT });
    await withParentEnv(undefined, async () => {
      await runWith(repo, { questions: false });
      assert.equal(process.env.BASTION_QUESTIONS, undefined);
    });
  });
});

describe('v1.1 run budget switch', () => {
  it('budget:false ignores maxCalls smaller than the node count: exit 0, no budgetHit, every call counted', async () => {
    const repo = createSwarmRepo({ nodes: [{ id: 'ba' }, { id: 'bb' }, { id: 'bc' }] });
    const { result } = await runWith(repo, { maxCalls: 1, budget: false });
    assert.equal(result, 0);
    const state = readRunStateFile(repo);
    assert.equal(state.budgetHit, undefined);
    assert.equal('budgetHit' in state, false);
    assert.equal(state.agentCalls, 3);
    assert.deepEqual([...(state.completedNodes as string[])].sort(), ['ba', 'bb', 'bc']);
    assert.equal(typeof state.accumulatedMinutes, 'number');
  });

  it('budget:false ignores config.budget', async () => {
    const repo = createSwarmRepo({
      nodes: [{ id: 'ba' }, { id: 'bb' }],
      configPatch: { budget: { maxAgentCalls: 1, maxMinutes: 0.000001 } },
    });
    const { result } = await runWith(repo, { budget: false });
    assert.equal(result, 0);
    const state = readRunStateFile(repo);
    assert.equal(state.budgetHit, undefined);
    assert.equal(state.agentCalls, 2);
    assert.equal((state.completedNodes as string[]).length, 2);
  });

  it('budget:false ignores maxMinutes', async () => {
    const repo = createSwarmRepo({ nodes: [{ id: 'ba' }, { id: 'bb' }] });
    const { result } = await runWith(repo, { maxMinutes: 0.000001, budget: false });
    assert.equal(result, 0);
    const state = readRunStateFile(repo);
    assert.equal(state.budgetHit, undefined);
    assert.equal(state.agentCalls, 2);
  });

  it('budget:false on resume after a budget stop finishes the run and clears budgetHit', async () => {
    const repo = createSwarmRepo({ nodes: [{ id: 'ba' }, { id: 'bb' }], configPatch: { budget: { maxAgentCalls: 1 } } });
    assert.equal((await runWith(repo, {})).result, EXIT_BUDGET);
    assert.equal(readRunStateFile(repo).budgetHit, 'calls');
    const { result } = await runWith(repo, { resume: true, budget: false });
    assert.equal(result, 0);
    const state = readRunStateFile(repo);
    assert.equal(state.budgetHit, undefined);
    assert.equal(state.agentCalls, 2);
    assert.deepEqual([...(state.completedNodes as string[])].sort(), ['ba', 'bb']);
  });

  for (const b of [undefined, true] as const) {
    it(`budget ${String(b)}: old behaviour, stops with EXIT_BUDGET and records budgetHit`, async () => {
      const repo = createSwarmRepo({ nodes: [{ id: 'ba' }, { id: 'bb' }, { id: 'bc' }] });
      const { result } = await runWith(repo, { maxCalls: 1, ...(b === undefined ? {} : { budget: b }) });
      assert.equal(result, EXIT_BUDGET);
      const state = readRunStateFile(repo);
      assert.equal(state.budgetHit, 'calls');
      assert.equal(state.agentCalls, 1);
    });
  }
});
