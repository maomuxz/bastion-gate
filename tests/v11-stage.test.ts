// v1.1: what `bastion run` does with the worktree after the gate passed (stageSafeWorktreeFiles in src/commands/run.ts).
// Added because a mutation of its "nothing left to stage -> fine" branch survived the whole suite twice.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { runSwarm } from '../src/commands/run.js';
import { AGENT_PRELUDE, captureConsole, cleanupTempRepos, createSwarmRepo, git, readRunStateFile } from './v04-helpers.js';

afterEach(() => cleanupTempRepos());

function runOpts(repo: string) {
  return { cwd: repo, baseRef: 'main', agentCommand: 'node scripts/agent.mjs', concurrency: 1, maxRetries: 0, mode: 'swarm' as const };
}

function integrationBranch(repo: string): string {
  return String(readRunStateFile(repo).integrationBranch);
}

const COMMIT_OWN_WORK = [
  AGENT_PRELUDE,
  'implementNode();',
  `const g = (...a) => execFileSync('git', ['-c', 'user.name=agent', '-c', 'user.email=agent@local', ...a], { encoding: 'utf8' });`,
  `g('add', 'src/' + id + '.mjs');`,
  `g('commit', '-m', 'agent: my own commit for ' + id);`,
].join('\n') + '\n';

describe('v1.1 run: staging after a passing gate', () => {
  it('an agent that committed its own work leaves nothing to stage: the node still passes and is merged', async () => {
    const repo = createSwarmRepo({ nodes: [{ id: 'sa' }], agentScript: COMMIT_OWN_WORK });
    const { result, out, err } = await captureConsole(() => runSwarm(runOpts(repo)));
    assert.equal(result, 0, out + err);
    assert.deepEqual(readRunStateFile(repo).completedNodes, ['sa']);
    assert.match(out, /\[sa\] GATE PASS on attempt 1\./);
    assert.doesNotMatch(out, /\[sa\] Staging /, 'there was nothing to stage');
    const branch = integrationBranch(repo);
    assert.equal(git(['show', `${branch}:src/sa.mjs`], repo).trim(), 'export const sa = 1;');
    const subjects = git(['log', '--format=%s', branch], repo);
    assert.match(subjects, /agent: my own commit for sa/, "the agent's commit is on the integration branch");
    assert.doesNotMatch(subjects, /feat\(sa\): apply verified changes/, 'bastion made no extra commit');
  });

  it('uncommitted work is staged and committed by bastion as "feat(<id>): apply verified changes"', async () => {
    const repo = createSwarmRepo({ nodes: [{ id: 'sb' }] });
    const { result, out, err } = await captureConsole(() => runSwarm(runOpts(repo)));
    assert.equal(result, 0, out + err);
    assert.match(out, /\[sb\] Staging 1 file\(s\): src\/sb\.mjs/);
    const branch = integrationBranch(repo);
    assert.match(git(['log', '--format=%s', branch], repo), /feat\(sb\): apply verified changes/);
    assert.equal(git(['show', `${branch}:src/sb.mjs`], repo).trim(), 'export const sb = 1;');
  });

  it('when only blocked files are left dirty they are skipped, not committed, and the node still passes', async () => {
    const script = COMMIT_OWN_WORK + `fs.writeFileSync('.env', 'SECRET=1\\n');\n`;
    const repo = createSwarmRepo({ nodes: [{ id: 'sc' }], agentScript: script });
    const { result, out, err } = await captureConsole(() => runSwarm(runOpts(repo)));
    assert.equal(result, 0, out + err);
    assert.deepEqual(readRunStateFile(repo).completedNodes, ['sc']);
    assert.match(out + err, /\[sc\] Skipping untracked\/sensitive files: \.env/);
    assert.doesNotMatch(out, /\[sc\] Staging /);
    const branch = integrationBranch(repo);
    const files = git(['ls-tree', '-r', '--name-only', branch], repo).split(/\r?\n/);
    assert.ok(!files.includes('.env'), '.env never reaches the integration branch');
    assert.ok(!fs.existsSync(path.join(repo, '.env')));
  });
});
