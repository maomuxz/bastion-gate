// N1 - role slots: roles.worker is used for construction; --agent wins; agentCommand is the fallback.
import * as assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { runSwarm } from '../src/commands/run.js';
import { BastionConfig, createDefaultConfig } from '../src/config.js';
import { resolveAgentCommand } from '../src/roles.js';
import { captureConsole, cleanupTempRepos, createSwarmRepo } from './v04-helpers.js';

afterEach(cleanupTempRepos);

function cfg(extra: Partial<BastionConfig>): BastionConfig {
  return { ...createDefaultConfig(), ...extra };
}

describe('v0.4 N1 roles', () => {
  it('uses roles.worker when configured', () => {
    assert.equal(resolveAgentCommand(cfg({ roles: { worker: 'W' }, agentCommand: 'A' }), 'worker'), 'W');
  });

  it('explicit --agent beats roles.worker', () => {
    assert.equal(resolveAgentCommand(cfg({ roles: { worker: 'W' }, agentCommand: 'A' }), 'worker', 'E'), 'E');
  });

  it('falls back to agentCommand when the role is not configured', () => {
    assert.equal(resolveAgentCommand(cfg({ agentCommand: 'A' }), 'worker'), 'A');
    // another role being set must not leak into worker
    assert.equal(resolveAgentCommand(cfg({ roles: { planner: 'P' }, agentCommand: 'A' }), 'worker'), 'A');
  });

  it('each role resolves its own slot', () => {
    const c = cfg({ roles: { planner: 'P', tester: 'T', worker: 'W', qa: 'Q' } });
    assert.equal(resolveAgentCommand(c, 'planner'), 'P');
    assert.equal(resolveAgentCommand(c, 'tester'), 'T');
    assert.equal(resolveAgentCommand(c, 'qa'), 'Q');
  });

  it('returns undefined when nothing is configured', () => {
    assert.equal(resolveAgentCommand(cfg({}), 'worker'), undefined);
  });

  it('bastion run builds with roles.worker when no agentCommand / --agent is given', async () => {
    const repo = createSwarmRepo({
      nodes: [{ id: 'ra' }],
      configPatch: { roles: { worker: 'node scripts/agent.mjs' } },
    });
    const { result } = await captureConsole(() => runSwarm({ cwd: repo, baseRef: 'main', maxRetries: 0 }));
    assert.equal(result, 0);
  });
});
