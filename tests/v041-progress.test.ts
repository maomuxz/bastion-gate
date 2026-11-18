// M4 (F6) - while a run is going, `bastion summary` shows which nodes are running.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { runSwarm } from '../src/commands/run.js';
import { summaryLines } from '../src/summary.js';
import {
  AGENT_PRELUDE,
  captureConsole,
  cleanupTempRepos,
  createSwarmRepo,
  createTempGitRepo,
  readRunStateFile,
  writeRepoFile,
} from './v04-helpers.js';

afterEach(cleanupTempRepos);

function seedState(repo: string, runningNodes: string[] | undefined): void {
  writeRepoFile(repo, '.bastion/plan.json', JSON.stringify({ version: 1, nodes: [{ id: 'a', title: 'A', prompt: 'A' }, { id: 'b', title: 'B', prompt: 'B' }] }));
  writeRepoFile(
    repo,
    '.bastion/run-state.json',
    JSON.stringify({ integrationBranch: 'bastion/run-x', baseRef: 'main', completedNodes: [], ...(runningNodes ? { runningNodes } : {}) })
  );
}

describe('v0.4.1 M4 progress', () => {
  it('adds a fourth line listing running nodes while a run is in progress', () => {
    const repo = createTempGitRepo();
    seedState(repo, ['a', 'b']);
    const lines = summaryLines(repo);
    assert.equal(lines.length, 4);
    assert.match(lines[0], /^Done: 0\/2 nodes/);
    assert.equal(lines[3], 'Running now: a, b');
  });

  it('stays at three lines when nothing is running', () => {
    const repo = createTempGitRepo();
    seedState(repo, []);
    assert.equal(summaryLines(repo).length, 3);
    seedState(repo, undefined);
    assert.equal(summaryLines(repo).length, 3);
  });

  it('run-state lists the node as running while its agent works, and clears it afterwards', async () => {
    const agent = [
      AGENT_PRELUDE,
      `const state = JSON.parse(fs.readFileSync(process.env.BASTION_HOME + '/.bastion/run-state.json', 'utf8'));`,
      `console.log('RUNNING=' + JSON.stringify(state.runningNodes));`,
      `implementNode();`,
    ].join('\n') + '\n';
    const repo = createSwarmRepo({ nodes: [{ id: 'pr' }], agentScript: agent });
    const { result } = await captureConsole(() =>
      runSwarm({ cwd: repo, baseRef: 'main', agentCommand: 'node scripts/agent.mjs', maxRetries: 0 })
    );
    assert.equal(result, 0);
    const log = fs.readFileSync(path.join(repo, '.bastion', 'logs', 'pr-attempt-1.log'), 'utf8');
    assert.match(log, /RUNNING=\["pr"\]/);
    assert.deepEqual(readRunStateFile(repo).runningNodes, []);
  });
});
