// M3 (F3) - every agent prompt starts with the bastion protocol (how to decide / ask / dispute).
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'node:test';
import { runSwarm } from '../src/commands/run.js';
import { agentProtocol } from '../src/protocol.js';
import { captureConsole, cleanupTempRepos, createSwarmRepo } from './v04-helpers.js';

afterEach(cleanupTempRepos);

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

describe('v0.4.1 M3 protocol', () => {
  it('names the node, the CLI path and the decide / ask / dispute commands', () => {
    const text = agentProtocol('n9', '/opt/bastion/cli.js');
    for (const s of ['n9', '/opt/bastion/cli.js', 'decide', '--title', '--chosen', '--why', '--undo', 'ask', '--question', '--recommend', '.bastion/disputes/n9.md']) {
      assert.ok(text.includes(s), `protocol mentions ${s}`);
    }
    assert.ok(text.endsWith('\n\n'), 'ends with a blank line');
  });

  it('bastion run puts the protocol in front of the node prompt', async () => {
    const repo = createSwarmRepo({ nodes: [{ id: 'pa' }] });
    const { result } = await captureConsole(() =>
      runSwarm({ cwd: repo, baseRef: 'main', agentCommand: 'node scripts/agent.mjs', maxRetries: 0 })
    );
    assert.equal(result, 0);
    const prompt = fs.readFileSync(path.join(repo, '.bastion', 'logs', 'pa-prompt.txt'), 'utf8');
    assert.ok(prompt.startsWith(agentProtocol('pa', CLI)), 'protocol comes first');
    assert.ok(prompt.trimEnd().endsWith('Implement pa'), 'node prompt follows');
  });
});
