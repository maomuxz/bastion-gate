// N4 - tier-3 inbox + ready queue: a question pauses only that node and its dependents.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { EXIT_FAILED, EXIT_WAITING, runSwarm } from '../src/commands/run.js';
import { answerQuestion, answersForNode, hasOpenQuestion, openQuestions, readInbox } from '../src/inbox.js';
import {
  AGENT_PRELUDE,
  captureConsole,
  cleanupTempRepos,
  createSwarmRepo,
  createTempGitRepo,
  readRunStateFile,
} from './v04-helpers.js';

afterEach(cleanupTempRepos);

const ASKING_AGENT = [
  AGENT_PRELUDE,
  `if (id === 'qa' && !prompt.includes('use-sqlite')) {`,
  `  cli('ask', '--question', 'Which database?', '--recommend', 'use-sqlite');`,
  `} else {`,
  `  implementNode();`,
  `}`,
].join('\n') + '\n';

describe('v0.4 N4 inbox', () => {
  it('openQuestions / answerQuestion / answersForNode round trip', () => {
    const repo = createTempGitRepo();
    const opened = openQuestions(repo, 'n1', [{ question: 'Which DB?', recommend: 'sqlite' }]);
    assert.equal(opened.length, 1);
    const q = opened[0];
    assert.equal(q.status, 'open');
    assert.equal(q.node, 'n1');
    assert.equal(q.question, 'Which DB?');
    assert.equal(q.recommend, 'sqlite');
    assert.ok(q.id && q.id.trim());
    assert.ok(!Number.isNaN(Date.parse(q.at)));
    assert.equal(hasOpenQuestion(repo, 'n1'), true);
    assert.deepEqual(answersForNode(repo, 'n1'), [], 'unanswered questions are not answers');

    const answered = answerQuestion(repo, q.id, 'postgres');
    assert.equal(answered.status, 'answered');
    assert.equal(answered.answer, 'postgres');
    assert.ok(answered.answeredAt && !Number.isNaN(Date.parse(answered.answeredAt)));
    assert.equal(hasOpenQuestion(repo, 'n1'), false);
    assert.equal(answersForNode(repo, 'n1').length, 1);
    assert.equal(readInbox(repo).length, 1);
  });

  it('ids are unique across nodes and answering an unknown id throws', () => {
    const repo = createTempGitRepo();
    openQuestions(repo, 'n1', [{ question: 'a' }]);
    openQuestions(repo, 'n2', [{ question: 'b' }, { question: 'c' }]);
    assert.equal(new Set(readInbox(repo).map((q) => q.id)).size, 3);
    assert.throws(() => answerQuestion(repo, 'no-such-id', 'x'));
  });

  it('a tier-3 question pauses only that node; independent nodes and their dependents still finish (exit 2)', async () => {
    const repo = createSwarmRepo({
      nodes: [{ id: 'qa' }, { id: 'qb' }, { id: 'qc', dependsOn: ['qb'] }],
      agentScript: ASKING_AGENT,
    });
    const first = await captureConsole(() =>
      runSwarm({ cwd: repo, baseRef: 'main', agentCommand: 'node scripts/agent.mjs', concurrency: 2, maxRetries: 1 })
    );
    assert.equal(first.result, EXIT_WAITING);
    const state = readRunStateFile(repo);
    assert.deepEqual([...(state.completedNodes as string[])].sort(), ['qb', 'qc']);
    assert.deepEqual(state.blockedNodes, ['qa']);
    const inbox = readInbox(repo);
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].node, 'qa');
    assert.equal(inbox[0].status, 'open');
    assert.equal(state.agentCalls, 3, 'the asking node is not retried');

    // resuming without an answer must not call the agent again for the paused node
    const again = await captureConsole(() =>
      runSwarm({ cwd: repo, baseRef: 'main', agentCommand: 'node scripts/agent.mjs', maxRetries: 1, resume: true })
    );
    assert.equal(again.result, EXIT_WAITING);
    assert.equal(readRunStateFile(repo).agentCalls, 3);

    answerQuestion(repo, inbox[0].id, 'use-sqlite');
    const done = await captureConsole(() =>
      runSwarm({ cwd: repo, baseRef: 'main', agentCommand: 'node scripts/agent.mjs', maxRetries: 1, resume: true })
    );
    assert.equal(done.result, 0);
    const final = readRunStateFile(repo);
    assert.deepEqual([...(final.completedNodes as string[])].sort(), ['qa', 'qb', 'qc']);
    assert.deepEqual(final.blockedNodes, []);
    const prompt = fs.readFileSync(path.join(repo, '.bastion', 'logs', 'qa-prompt.txt'), 'utf8');
    assert.ok(prompt.includes('use-sqlite'), 'the answer is carried into the prompt');
  });

  it('a hard failure stops only the failed node and its dependents (exit 1)', async () => {
    const agent = [AGENT_PRELUDE, `if (id === 'fa') process.exit(1);`, `implementNode();`].join('\n') + '\n';
    const repo = createSwarmRepo({
      nodes: [{ id: 'fa' }, { id: 'fb' }, { id: 'fc', dependsOn: ['fa'] }, { id: 'fd', dependsOn: ['fb'] }],
      agentScript: agent,
    });
    const { result } = await captureConsole(() =>
      runSwarm({ cwd: repo, baseRef: 'main', agentCommand: 'node scripts/agent.mjs', concurrency: 2, maxRetries: 0 })
    );
    assert.equal(result, EXIT_FAILED);
    const state = readRunStateFile(repo);
    assert.deepEqual([...(state.completedNodes as string[])].sort(), ['fb', 'fd']);
  });
});
