// v1.1 `bastion reopen`: errors write nothing; effects on run-state and feedback; end-to-end rebuild order.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { runReopen } from '../src/commands/reopen.js';
import { runSwarm } from '../src/commands/run.js';
import { RunState } from '../src/state.js';
import {
  AGENT_PRELUDE,
  captureConsole,
  cleanupTempRepos,
  createSwarmRepo,
  createTempGitRepo,
  readRunStateFile,
  writeRepoFile,
} from './v04-helpers.js';

const extraTemp: string[] = [];
afterEach(() => {
  cleanupTempRepos();
  while (extraTemp.length > 0) fs.rmSync(extraTemp.pop()!, { recursive: true, force: true });
});

const STATE_PATH = '.bastion/run-state.json';
const feedbackPath = (repo: string, id: string) => path.join(repo, '.bastion', 'feedback', `${id}.md`);

/** Plan: a <- b <- c, and d independent. */
function seed(extra: Partial<RunState> = {}, withPlan = true): { repo: string; state: RunState } {
  const repo = createTempGitRepo();
  if (withPlan) {
    writeRepoFile(
      repo,
      '.bastion/plan.json',
      JSON.stringify({
        version: 1,
        nodes: [
          { id: 'a', title: 'A', prompt: 'A' },
          { id: 'b', title: 'B', prompt: 'B', dependsOn: ['a'] },
          { id: 'c', title: 'C', prompt: 'C', dependsOn: ['b'] },
          { id: 'd', title: 'D', prompt: 'D' },
        ],
      })
    );
  }
  const state: RunState = {
    integrationBranch: 'bastion/run-x',
    baseRef: 'main',
    completedNodes: ['a', 'b', 'c', 'd'],
    agentCalls: 7,
    accumulatedMinutes: 1.5,
    blockedNodes: [],
    runningNodes: [],
    ...extra,
  };
  writeRepoFile(repo, STATE_PATH, JSON.stringify(state, null, 2) + '\n');
  return { repo, state };
}

function readState(repo: string): RunState {
  return readRunStateFile(repo) as unknown as RunState;
}

async function reopen(repo: string, node: string, reason: string, before?: string) {
  return captureConsole(() => runReopen({ cwd: repo, node, reason, ...(before !== undefined ? { before } : {}) }));
}

/** Run an error case and prove nothing was written. */
async function assertRejected(repo: string, node: string, reason: string, before?: string): Promise<string> {
  const stateFile = path.join(repo, STATE_PATH);
  const snapshot = fs.existsSync(stateFile) ? fs.readFileSync(stateFile, 'utf8') : null;
  const r = await reopen(repo, node, reason, before);
  assert.equal(r.result, 1, `expected failure, got ${r.result}\nout=${r.out}\nerr=${r.err}`);
  assert.match(r.err, /\[bastion\] reopen: \S/);
  assert.doesNotMatch(r.err, /not implemented/, 'must be a real validation error');
  assert.equal(fs.existsSync(stateFile) ? fs.readFileSync(stateFile, 'utf8') : null, snapshot, 'run-state untouched');
  assert.ok(!fs.existsSync(path.join(repo, '.bastion', 'feedback')) || fs.readdirSync(path.join(repo, '.bastion', 'feedback')).length === 0, 'no feedback written');
  return r.err;
}

describe('v1.1 reopen: errors (return 1, nothing written)', () => {
  it('works on a valid input first (guards the error tests below against a stub that always fails)', async () => {
    const { repo } = seed();
    const r = await reopen(repo, 'd', 'because');
    assert.equal(r.result, 0, r.err);
  });

  it('not inside a git repository', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bastion-v11-nogit-'));
    extraTemp.push(dir);
    const r = await reopen(dir, 'a', 'why');
    assert.equal(r.result, 1);
    assert.match(r.err, /\[bastion\] reopen: \S/);
    assert.doesNotMatch(r.err, /not implemented/);
    assert.deepEqual(fs.readdirSync(dir), [], 'nothing written outside a repo');
  });

  it('no run-state', async () => {
    const { repo } = seed();
    fs.rmSync(path.join(repo, STATE_PATH));
    const r = await reopen(repo, 'a', 'why');
    assert.equal(r.result, 1);
    assert.match(r.err, /\[bastion\] reopen: \S/);
    assert.doesNotMatch(r.err, /not implemented/);
    assert.ok(!fs.existsSync(path.join(repo, STATE_PATH)));
    assert.ok(!fs.existsSync(feedbackPath(repo, 'a')));
  });

  it('missing or unreadable plan', async () => {
    const missing = seed({}, false);
    await assertRejected(missing.repo, 'a', 'why');
    const broken = seed();
    writeRepoFile(broken.repo, '.bastion/plan.json', '{ not json');
    await assertRejected(broken.repo, 'a', 'why');
  });

  it('node is not a plan node id', async () => {
    const { repo } = seed();
    await assertRejected(repo, 'zzz', 'why');
    await assertRejected(repo, '', 'why');
  });

  it('blank reason', async () => {
    const { repo } = seed();
    await assertRejected(repo, 'a', '');
    await assertRejected(repo, 'a', '   \t\n ');
  });

  it('--before is not a plan node id, or equals the node', async () => {
    const { repo } = seed();
    await assertRejected(repo, 'a', 'why', 'nope');
    await assertRejected(repo, 'a', 'why', 'a');
  });

  it('--before would be a cycle: node already depends on it directly, transitively, or through extraDeps', async () => {
    const { repo } = seed();
    await assertRejected(repo, 'b', 'why', 'a'); // direct plan dependsOn
    await assertRejected(repo, 'c', 'why', 'a'); // transitive c -> b -> a

    const viaExtra = seed({ extraDeps: { d: ['a'] } });
    await assertRejected(viaExtra.repo, 'd', 'why', 'a'); // direct extraDeps

    const mixed = seed({ extraDeps: { b: ['d'] } });
    await assertRejected(mixed.repo, 'c', 'why', 'd'); // c -> b (plan) -> d (extraDeps)

    const chain = seed({ extraDeps: { a: ['d'], d: ['c'] } });
    await assertRejected(chain.repo, 'a', 'why', 'c'); // a -> d (extra) -> c (extra)
  });

  it('the opposite direction is not a cycle', async () => {
    const { repo } = seed();
    const r = await reopen(repo, 'a', 'why', 'c'); // c depends on a; c waits for a - fine
    assert.equal(r.result, 0, r.err);
    assert.deepEqual(readState(repo).extraDeps, { c: ['a'] });
  });
});

describe('v1.1 reopen: effects', () => {
  it('removes the node from completedNodes and blockedNodes, writes "- reason" feedback, prints the hint, keeps every other field', async () => {
    const { repo } = seed({
      completedNodes: ['a', 'b', 'd'],
      blockedNodes: ['a', 'c'],
      runningNodes: ['c'],
      budgetHit: 'calls',
      extraDeps: { d: ['c'] },
    });
    const r = await reopen(repo, 'a', '  the locked test is right; fix the parser  \n');
    assert.equal(r.result, 0, r.err);
    assert.ok(r.out.includes('[bastion] reopen: a will be rebuilt. Next: bastion run --resume'), r.out);
    const s = readState(repo);
    assert.deepEqual(s.completedNodes, ['b', 'd']);
    assert.deepEqual(s.blockedNodes, ['c']);
    assert.equal(s.integrationBranch, 'bastion/run-x');
    assert.equal(s.baseRef, 'main');
    assert.equal(s.agentCalls, 7);
    assert.equal(s.accumulatedMinutes, 1.5);
    assert.deepEqual(s.runningNodes, ['c']);
    assert.equal(s.budgetHit, 'calls');
    assert.deepEqual(s.extraDeps, { d: ['c'] }, 'extraDeps untouched without --before');
    assert.equal(fs.readFileSync(feedbackPath(repo, 'a'), 'utf8').trim(), '- the locked test is right; fix the parser');
  });

  it('works for a node that is in neither list, and does not invent extraDeps without --before', async () => {
    const { repo } = seed({ completedNodes: ['d'], blockedNodes: undefined });
    const r = await reopen(repo, 'a', 'rebuild please');
    assert.equal(r.result, 0, r.err);
    const s = readState(repo);
    assert.deepEqual(s.completedNodes, ['d']);
    assert.ok(!s.blockedNodes || s.blockedNodes.length === 0);
    assert.ok(!s.extraDeps || Object.keys(s.extraDeps).length === 0);
    assert.equal(fs.readFileSync(feedbackPath(repo, 'a'), 'utf8').trim(), '- rebuild please');
  });

  it('appends to existing feedback (content kept, own line, with or without trailing newline) and across repeated reopens', async () => {
    const { repo } = seed();
    writeRepoFile(repo, '.bastion/feedback/a.md', 'QA said: broken'); // no trailing newline
    assert.equal((await reopen(repo, 'a', 'first reason')).result, 0);
    assert.equal((await reopen(repo, 'a', 'second reason')).result, 0);
    const lines = fs.readFileSync(feedbackPath(repo, 'a'), 'utf8').split(/\r?\n/).filter((l) => l.trim());
    assert.deepEqual(lines, ['QA said: broken', '- first reason', '- second reason']);

    writeRepoFile(repo, '.bastion/feedback/d.md', 'old\n'); // with trailing newline
    assert.equal((await reopen(repo, 'd', 'why d')).result, 0);
    assert.deepEqual(fs.readFileSync(feedbackPath(repo, 'd'), 'utf8').split(/\r?\n/).filter((l) => l.trim()), ['old', '- why d']);
  });

  it('--before adds node to extraDeps[before] without duplicates and keeps other entries', async () => {
    const { repo } = seed({ extraDeps: { c: ['d'], x: ['y'] }, completedNodes: ['a', 'b', 'c', 'd'] });
    const r = await reopen(repo, 'a', 'rebuild', 'd');
    assert.equal(r.result, 0, r.err);
    let s = readState(repo);
    assert.deepEqual(s.extraDeps, { c: ['d'], x: ['y'], d: ['a'] });
    assert.deepEqual(s.completedNodes, ['b', 'c', 'd'], 'before stays completed, node removed');

    assert.equal((await reopen(repo, 'a', 'again', 'd')).result, 0);
    s = readState(repo);
    assert.deepEqual(s.extraDeps!.d, ['a'], 'no duplicate');

    assert.equal((await reopen(repo, 'b', 'other', 'd')).result, 0);
    assert.deepEqual(readState(repo).extraDeps!.d, ['a', 'b'], 'appended after existing');
  });

  it('--before is removed from blockedNodes (and the node too)', async () => {
    const { repo } = seed({ completedNodes: ['a'], blockedNodes: ['d', 'a', 'c'] });
    const r = await reopen(repo, 'a', 'rebuild', 'd');
    assert.equal(r.result, 0, r.err);
    const s = readState(repo);
    assert.deepEqual(s.blockedNodes, ['c']);
    assert.deepEqual(s.completedNodes, []);
    assert.deepEqual(s.extraDeps, { d: ['a'] });
  });
});

describe('v1.1 reopen: end to end', () => {
  // rb refuses to run unless ra's rebuilt version (it carries a marker) is already on its integration branch.
  const AGENT = [
    AGENT_PRELUDE,
    `if (id === 'rb' && process.env.V11_FAIL_B) process.exit(1);`,
    `if (id === 'rb') {`,
    `  const rebuilt = fs.readFileSync('src/ra.mjs', 'utf8').includes('rebuilt');`,
    `  console.log('A_REBUILT=' + rebuilt);`,
    `  if (!rebuilt) process.exit(1);`,
    `}`,
    `implementNode();`,
    `if (id === 'ra' && prompt.includes('REOPEN-REASON-XYZ')) fs.appendFileSync('src/ra.mjs', '// rebuilt\\n');`,
  ].join('\n') + '\n';

  it('reopened node ra is rebuilt with the reason in its prompt, before rb is touched', async () => {
    const repo = createSwarmRepo({ nodes: [{ id: 'ra' }, { id: 'rb' }], agentScript: AGENT });
    const opts = (extra: Record<string, unknown> = {}) => ({
      cwd: repo, baseRef: 'main', agentCommand: 'node scripts/agent.mjs', concurrency: 1, maxRetries: 0, ...extra,
    });

    process.env.V11_FAIL_B = '1';
    let first;
    try {
      first = await captureConsole(() => runSwarm(opts()));
    } finally {
      delete process.env.V11_FAIL_B;
    }
    assert.equal(first.result, 1, 'rb fails, ra completed');
    assert.deepEqual(readRunStateFile(repo).completedNodes, ['ra']);

    const re = await reopen(repo, 'ra', 'REOPEN-REASON-XYZ: the parser is wrong', 'rb');
    assert.equal(re.result, 0, re.err);
    const mid = readRunStateFile(repo);
    assert.deepEqual(mid.completedNodes, []);
    assert.deepEqual(mid.extraDeps, { rb: ['ra'] });

    const second = await captureConsole(() => runSwarm(opts({ resume: true, concurrency: 2 })));
    assert.equal(second.result, 0, `${second.err}\n${second.out}`);
    const prompt = fs.readFileSync(path.join(repo, '.bastion', 'logs', 'ra-prompt.txt'), 'utf8');
    assert.ok(prompt.includes('REOPEN-REASON-XYZ: the parser is wrong'), 'reason reaches the node prompt');
    assert.ok(second.out.indexOf('[bastion] Merging bastion/ra') < second.out.indexOf('[rb] Attempt 1/1'), 'ra is merged before rb starts');
    const rbLogs = fs.readdirSync(path.join(repo, '.bastion', 'logs')).filter((f) => f.startsWith('rb-attempt'));
    const rbLast = rbLogs.sort().pop()!;
    assert.match(fs.readFileSync(path.join(repo, '.bastion', 'logs', rbLast), 'utf8'), /A_REBUILT=true/);
    const done = readRunStateFile(repo);
    assert.deepEqual([...(done.completedNodes as string[])].sort(), ['ra', 'rb']);
    assert.ok(!fs.existsSync(feedbackPath(repo, 'ra')), 'feedback is consumed once the node passes');
  });
});
