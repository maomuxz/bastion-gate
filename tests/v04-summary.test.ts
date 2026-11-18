// N6 - `bastion summary`: three lines for a user who was away.
import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'node:test';
import { summaryLines } from '../src/summary.js';
import { cleanupTempRepos, createTempGitRepo, writeRepoFile } from './v04-helpers.js';

afterEach(cleanupTempRepos);

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

function seed(repo: string): void {
  writeRepoFile(
    repo,
    '.bastion/plan.json',
    JSON.stringify({ version: 1, nodes: [{ id: 'a', title: 'A', prompt: 'A' }, { id: 'b', title: 'B', prompt: 'B' }, { id: 'c', title: 'C', prompt: 'C' }] })
  );
  writeRepoFile(
    repo,
    '.bastion/run-state.json',
    JSON.stringify({ integrationBranch: 'bastion/run-x', baseRef: 'main', completedNodes: ['a', 'b'], blockedNodes: ['c'], agentCalls: 4 })
  );
  writeRepoFile(
    repo,
    '.bastion/decisions.json',
    JSON.stringify([{ id: 'd1', at: '2026-11-18T09:00:00.000Z', tier: 2, node: 'a', title: 'Storage', chosen: 'json', why: 'simple' }])
  );
  writeRepoFile(
    repo,
    '.bastion/inbox.json',
    JSON.stringify([
      { id: 'q1', at: '2026-11-18T09:10:00.000Z', node: 'c', question: 'Which DB?', status: 'open' },
      { id: 'q2', at: '2026-11-18T09:20:00.000Z', node: 'c', question: 'Which port?', status: 'open' },
      { id: 'q0', at: '2026-11-18T08:00:00.000Z', node: 'b', question: 'Old one', status: 'answered', answer: 'x', answeredAt: '2026-11-18T08:30:00.000Z' },
    ])
  );
}

describe('v0.4 N6 summary', () => {
  it('prints exactly three lines: done / decided for you / waiting for you', () => {
    const repo = createTempGitRepo();
    seed(repo);
    const lines = summaryLines(repo);
    assert.equal(lines.length, 3);
    assert.match(lines[0], /^Done: 2\/3 nodes\b/);
    assert.match(lines[1], /^Decided for you: 1\b/);
    assert.match(lines[2], /^Waiting for you: 2\b/, 'answered questions are not waiting');
  });

  it('works on a fresh repo with no bastion state', () => {
    const repo = createTempGitRepo();
    const lines = summaryLines(repo);
    assert.equal(lines.length, 3);
    assert.match(lines[0], /^Done: 0\/0 nodes\b/);
    assert.match(lines[1], /^Decided for you: 0\b/);
    assert.match(lines[2], /^Waiting for you: 0\b/);
  });

  it('`bastion summary` prints the three lines and exits 0', () => {
    const repo = createTempGitRepo();
    seed(repo);
    const res = spawnSync(process.execPath, [CLI, 'summary'], { cwd: repo, encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    const lines = res.stdout.trim().split(/\r?\n/);
    assert.equal(lines.length, 3);
    assert.match(lines[0], /^Done: 2\/3 nodes/);
  });
});
