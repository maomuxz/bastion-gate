// N5 - budget gate: stop before the next agent call once calls/minutes reach the limit; resume with more.
import * as assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { checkBudget, resolveBudgetLimits } from '../src/budget.js';
import { EXIT_BUDGET, runSwarm } from '../src/commands/run.js';
import { BastionConfig, createDefaultConfig } from '../src/config.js';
import { captureConsole, cleanupTempRepos, createSwarmRepo, readRunStateFile } from './v04-helpers.js';

afterEach(cleanupTempRepos);

function cfg(extra: Partial<BastionConfig>): BastionConfig {
  return { ...createDefaultConfig(), ...extra };
}

describe('v0.4 N5 budget', () => {
  it('resolveBudgetLimits takes config.budget and lets flags override field by field', () => {
    const c = cfg({ budget: { maxAgentCalls: 5, maxMinutes: 10 } });
    assert.deepEqual(resolveBudgetLimits(c, {}), { maxAgentCalls: 5, maxMinutes: 10 });
    assert.deepEqual(resolveBudgetLimits(c, { maxAgentCalls: 8 }), { maxAgentCalls: 8, maxMinutes: 10 });
    assert.deepEqual(resolveBudgetLimits(cfg({}), { maxMinutes: 3 }), { maxMinutes: 3 });
    assert.deepEqual(resolveBudgetLimits(cfg({}), {}), {});
  });

  it('checkBudget reports the limit that is reached (usage >= limit)', () => {
    assert.equal(checkBudget({ agentCalls: 2, minutes: 1 }, { maxAgentCalls: 2 }), 'calls');
    assert.equal(checkBudget({ agentCalls: 1, minutes: 1 }, { maxAgentCalls: 2 }), null);
    assert.equal(checkBudget({ agentCalls: 0, minutes: 10 }, { maxMinutes: 10 }), 'minutes');
    assert.equal(checkBudget({ agentCalls: 0, minutes: 9.9 }, { maxMinutes: 10 }), null);
    assert.equal(checkBudget({ agentCalls: 99, minutes: 99 }, {}), null);
    assert.equal(checkBudget({ agentCalls: 5, minutes: 50 }, { maxAgentCalls: 5, maxMinutes: 50 }), 'calls', 'calls is checked first');
  });

  it('run stops with exit 3 when calls run out, keeps finished work, and resumes with a larger budget', async () => {
    const repo = createSwarmRepo({
      nodes: [{ id: 'ba' }, { id: 'bb' }],
      configPatch: { budget: { maxAgentCalls: 1 } },
    });
    const run = (extra: Record<string, unknown>) =>
      captureConsole(() =>
        runSwarm({ cwd: repo, baseRef: 'main', agentCommand: 'node scripts/agent.mjs', concurrency: 1, maxRetries: 0, ...extra })
      );

    const first = await run({});
    assert.equal(first.result, EXIT_BUDGET);
    let state = readRunStateFile(repo);
    assert.equal(state.budgetHit, 'calls');
    assert.equal(state.agentCalls, 1);
    assert.equal((state.completedNodes as string[]).length, 1, 'the node that finished is kept');

    const same = await run({ resume: true });
    assert.equal(same.result, EXIT_BUDGET, 'config limit still applies to used calls on resume');
    assert.equal(readRunStateFile(repo).agentCalls, 1, 'no agent call was made');

    const more = await run({ resume: true, maxCalls: 5 });
    assert.equal(more.result, 0);
    state = readRunStateFile(repo);
    assert.equal(state.agentCalls, 2);
    assert.equal(state.budgetHit, undefined);
    assert.deepEqual([...(state.completedNodes as string[])].sort(), ['ba', 'bb']);
  });
});
