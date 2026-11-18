// v1.0 single mode - resolveRunMode, mergeNodesForSingle, and the run.ts wiring.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { runSwarm } from '../src/commands/run.js';
import { createDefaultConfig, PlanNode } from '../src/config.js';
import { mergeNodesForSingle, resolveRunMode, SINGLE_NODE_ID } from '../src/single.js';
import { AGENT_PRELUDE, captureConsole, cleanupTempRepos, createSwarmRepo, readRunStateFile } from './v04-helpers.js';

afterEach(cleanupTempRepos);

type Cfg = Parameters<typeof createDefaultConfig>[0];
const cfg = (patch: Record<string, unknown> = {}) => ({ ...createDefaultConfig(), ...patch }) as ReturnType<typeof createDefaultConfig>;
void (undefined as unknown as Cfg);

describe('v1.0 resolveRunMode', () => {
  it('defaults to swarm when runMode is unset, regardless of size', () => {
    assert.equal(resolveRunMode(cfg(), undefined, 1), 'swarm');
    assert.equal(resolveRunMode(cfg(), undefined, 50), 'swarm');
  });

  it('honours explicit config runMode swarm / single regardless of node count', () => {
    assert.equal(resolveRunMode(cfg({ runMode: 'single' }), undefined, 40), 'single');
    assert.equal(resolveRunMode(cfg({ runMode: 'swarm' }), undefined, 1), 'swarm');
  });

  it('auto: single when nodeCount <= singleMaxNodes (default 3), swarm above; boundary is inclusive', () => {
    const auto = cfg({ runMode: 'auto' });
    assert.equal(resolveRunMode(auto, undefined, 3), 'single');
    assert.equal(resolveRunMode(auto, undefined, 4), 'swarm');
    const five = cfg({ runMode: 'auto', singleMaxNodes: 5 });
    assert.equal(resolveRunMode(five, undefined, 5), 'single');
    assert.equal(resolveRunMode(five, undefined, 6), 'swarm');
    const zero = cfg({ runMode: 'auto', singleMaxNodes: 0 });
    assert.equal(resolveRunMode(zero, undefined, 1), 'swarm');
  });

  it('requested mode wins over every config value', () => {
    assert.equal(resolveRunMode(cfg({ runMode: 'swarm' }), 'single', 10), 'single');
    assert.equal(resolveRunMode(cfg({ runMode: 'single' }), 'swarm', 1), 'swarm');
    assert.equal(resolveRunMode(cfg({ runMode: 'auto' }), 'swarm', 1), 'swarm');
    assert.equal(resolveRunMode(cfg(), 'single', 99), 'single');
  });
});

describe('v1.0 mergeNodesForSingle', () => {
  const node = (id: string, extra: Partial<PlanNode> = {}): PlanNode => ({ id, title: `Title ${id}`, prompt: `PROMPT-${id}`, tier: 2, testCommand: `node --test tests/${id}.test.mjs`, ...extra });

  it('produces the synthetic node with id, title, full testCommand, tier 1 and no dependsOn', () => {
    const merged = mergeNodesForSingle([node('a'), node('b', { dependsOn: ['a'] })], 'npm test -- --all');
    assert.equal(SINGLE_NODE_ID, 'all-nodes');
    assert.equal(merged.id, SINGLE_NODE_ID);
    assert.equal(merged.title, 'All nodes (2)');
    assert.equal(merged.testCommand, 'npm test -- --all');
    assert.equal(merged.tier, 1);
    assert.ok(merged.dependsOn === undefined || merged.dependsOn.length === 0);
  });

  it('title counts nodes', () => {
    const merged = mergeNodesForSingle([node('a'), node('b'), node('c')], 'x');
    assert.equal(merged.title, 'All nodes (3)');
  });

  it('lists every node as "## <i>. <id>: <title>" followed by its prompt, in plan order when independent', () => {
    const { prompt } = mergeNodesForSingle([node('a'), node('b'), node('c')], 'x');
    const ia = prompt.indexOf('## 1. a: Title a');
    const ib = prompt.indexOf('## 2. b: Title b');
    const ic = prompt.indexOf('## 3. c: Title c');
    assert.ok(ia >= 0 && ib > ia && ic > ib, prompt);
    assert.ok(prompt.indexOf('PROMPT-a') > ia && prompt.indexOf('PROMPT-a') < ib);
    assert.ok(prompt.indexOf('PROMPT-b') > ib && prompt.indexOf('PROMPT-b') < ic);
    assert.ok(prompt.indexOf('PROMPT-c') > ic);
  });

  it('orders topologically: dependencies first even when declared later; ties keep plan order', () => {
    const nodes = [node('c', { dependsOn: ['b'] }), node('a'), node('b', { dependsOn: ['a'] }), node('d')];
    const { prompt } = mergeNodesForSingle(nodes, 'x');
    const order = [...prompt.matchAll(/^## (\d+)\. (\w+): /gm)].map((m) => `${m[1]}:${m[2]}`);
    const ids = order.map((s) => s.split(':')[1]);
    // Ready set starts {a, d}; a first (plan order). Then {b, d}: b precedes d in plan order. Then {c, d}: c precedes d.
    assert.deepEqual(ids, ['a', 'b', 'c', 'd']);
    assert.deepEqual(order.map((s) => s.split(':')[0]), ['1', '2', '3', '4']);
  });

  it('tells the agent to finish the nodes in that order', () => {
    const { prompt } = mergeNodesForSingle([node('a'), node('b')], 'x');
    assert.match(prompt, /order/i);
  });

  it('does not mutate its input', () => {
    const nodes = [node('b', { dependsOn: ['a'] }), node('a')];
    const copy = JSON.parse(JSON.stringify(nodes));
    mergeNodesForSingle(nodes, 'x');
    assert.deepEqual(nodes, copy);
  });
});

describe('v1.0 single mode in runSwarm', () => {
  const agent = [
    AGENT_PRELUDE,
    `if (id === 'all-nodes') { for (const n of ['a', 'b']) fs.writeFileSync('src/' + n + '.mjs', 'export const ' + n + ' = 1;\\n'); }`,
    `else implementNode();`,
  ].join('\n') + '\n';

  const attemptLogs = (repo: string) => fs.readdirSync(path.join(repo, '.bastion', 'logs')).filter((f) => /-attempt-\d+\.log$/.test(f));

  it('runMode "single": one agent call for the whole plan, both nodes completed', async () => {
    const repo = createSwarmRepo({ nodes: [{ id: 'a' }, { id: 'b', dependsOn: ['a'] }], agentScript: agent, configPatch: { runMode: 'single' } });
    const { result } = await captureConsole(() => runSwarm({ cwd: repo, baseRef: 'main', agentCommand: 'node scripts/agent.mjs', maxRetries: 0 }));
    assert.equal(result, 0);
    const logs = attemptLogs(repo);
    assert.equal(logs.length, 1, logs.join(','));
    assert.match(logs[0], /^all-nodes-attempt-1\.log$/);
    const completed = readRunStateFile(repo).completedNodes as string[];
    assert.deepEqual([...completed].sort(), ['a', 'b']);
  });

  it('runMode unset: one agent call per node', async () => {
    const repo = createSwarmRepo({ nodes: [{ id: 'a' }, { id: 'b', dependsOn: ['a'] }], agentScript: agent });
    const { result } = await captureConsole(() => runSwarm({ cwd: repo, baseRef: 'main', agentCommand: 'node scripts/agent.mjs', maxRetries: 0 }));
    assert.equal(result, 0);
    const logs = attemptLogs(repo).sort();
    assert.deepEqual(logs, ['a-attempt-1.log', 'b-attempt-1.log']);
    assert.deepEqual([...(readRunStateFile(repo).completedNodes as string[])].sort(), ['a', 'b']);
  });
});
