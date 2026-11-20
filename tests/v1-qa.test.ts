// v1.0 P7 - `bastion qa`: parseQaReport + runQa, plus the run --resume feedback wiring. All roles are the fake role script.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { parseQaReport, runQa } from '../src/commands/qa.js';
import { runLock } from '../src/commands/lock.js';
import { runSwarm } from '../src/commands/run.js';
import { QA_DISPUTES_REL_PATH, QA_REPORT_REL_PATH } from '../src/commands/stages.js';
import {
  captureConsole,
  cleanupTempRepos,
  git,
  readJson,
  writeRepoFile,
} from './v04-helpers.js';
import { createRoleRepo, readRoleCalls, SAMPLE_FILES, sampleMap, setFixtures } from './v1-helpers.js';
import type { RoleFixtures } from './v1-helpers.js';

afterEach(cleanupTempRepos);

const ACCEPTANCE = '# Acceptance\n\n## n1 Add\n- add(2, 3) is 5\n\n## n2 Mul\n- mul(4, 5) is 20\n';

// mapToPlan is still a stub, so the plan is built by hand.
function planFromMap(map: ReturnType<typeof sampleMap>) {
  return {
    version: 1,
    nodes: map.nodes.map((n) => ({
      id: n.id,
      title: n.title,
      prompt: `${n.summary}\nEdit only: ${n.files.join(', ')}\n${n.interface}`,
      testCommand: n.testCommand,
      ...(n.dependsOn ? { dependsOn: n.dependsOn } : {}),
      tier: 1,
    })),
  };
}

// v1.1: a qa report must carry at least one black-box case; the case script is written by the fake role into its cwd.
const QA_CASE = { name: 'c1', rule: 'calculator works', node: 'n1', command: 'node .bastion/qa-cases/c1.mjs' };
function withCase(qa: unknown): unknown {
  return typeof qa === 'object' && qa !== null && !Array.isArray(qa) ? { ...qa, cases: [QA_CASE] } : qa;
}

function runFixtures(qa?: unknown, implOverride?: Record<string, string>): RoleFixtures {
  const impl = implOverride ?? SAMPLE_FILES.impl;
  return {
    run: {
      byLabel: {
        n1: { files: { 'src/add.mjs': impl['src/add.mjs'] } },
        n2: { files: { 'src/mul.mjs': impl['src/mul.mjs'] } },
      },
    },
    ...(qa === undefined ? {} : { qa: { output: withCase(qa), files: { '.bastion/qa-cases/c1.mjs': 'process.exit(0);\n' } } }),
  };
}

/** A locked repo whose two nodes were built by `bastion run` (fake agent); the qa role is configured by `qa`. */
async function createCompletedRun(qa?: unknown, impl?: Record<string, string>): Promise<string> {
  const map = sampleMap();
  const repo = createRoleRepo({
    fixtures: runFixtures(qa, impl),
    files: {
      ...SAMPLE_FILES.stubs,
      ...SAMPLE_FILES.tests,
      '.bastion/acceptance.md': ACCEPTANCE,
      '.bastion/plan.json': JSON.stringify(planFromMap(map), null, 2),
    },
  });
  assert.equal(runLock({ cwd: repo }), 0);
  git(['add', '.'], repo);
  git(['commit', '-m', 'chore: lock'], repo);
  const { result } = await captureConsole(() =>
    runSwarm({ cwd: repo, baseRef: 'main', agentCommand: 'node scripts/role.mjs', maxRetries: 0 })
  );
  assert.equal(result, 0, 'fixture run must complete');
  assert.deepEqual(completed(repo).sort(), ['n1', 'n2']);
  return repo;
}

function completed(repo: string): string[] {
  return readJson<{ completedNodes: string[] }>(path.join(repo, '.bastion', 'run-state.json')).completedNodes;
}
const feedbackPath = (repo: string, id: string) => path.join(repo, '.bastion', 'feedback', `${id}.md`);
const qaCalls = (repo: string) => readRoleCalls(repo).filter((c) => c.role === 'qa');

describe('v1.0 parseQaReport', () => {
  it('accepts pass and fail reports and returns them intact', () => {
    assert.deepEqual(parseQaReport({ verdict: 'pass', findings: [] }), { verdict: 'pass', findings: [], cases: [] });
    const fail = {
      verdict: 'fail',
      findings: [
        { node: 'n1', kind: 'code', issue: 'add ignores negatives' },
        { node: 'n2', kind: 'test_defect', issue: 'test expects 21' },
      ],
    };
    assert.deepEqual(parseQaReport(fail), { ...fail, cases: [] });
  });

  it('rejects anything that is not a well-formed report', () => {
    const bad: unknown[] = [
      null,
      undefined,
      'pass',
      42,
      [],
      {},
      { verdict: 'pass' },
      { findings: [] },
      { verdict: 'maybe', findings: [] },
      { verdict: 'PASS', findings: [] },
      { verdict: 'pass', findings: 'none' },
      { verdict: 'pass', findings: {} },
      { verdict: 'fail', findings: [null] },
      { verdict: 'fail', findings: ['n1'] },
      { verdict: 'fail', findings: [{ kind: 'code', issue: 'x' }] },
      { verdict: 'fail', findings: [{ node: 'n1', issue: 'x' }] },
      { verdict: 'fail', findings: [{ node: 'n1', kind: 'code' }] },
      { verdict: 'fail', findings: [{ node: 'n1', kind: 'bug', issue: 'x' }] },
      { verdict: 'fail', findings: [{ node: 1, kind: 'code', issue: 'x' }] },
      { verdict: 'fail', findings: [{ node: 'n1', kind: 'code', issue: 5 }] },
      { verdict: 'fail', findings: [{ node: 'n1', kind: 'code', issue: 'ok' }, { node: 'n2', kind: 'code' }] },
    ];
    for (const b of bad) assert.equal(parseQaReport(b), null, `should reject ${JSON.stringify(b)}`);
  });
});

describe('v1.0 runQa', () => {
  it('v1.1: without a run-state qa runs standalone against HEAD - the role is called and no run-state is created', async () => {
    const repo = createRoleRepo({
      fixtures: { qa: { output: withCase({ verdict: 'pass', findings: [] }), files: { '.bastion/qa-cases/c1.mjs': 'process.exit(0);\n' } } },
      files: { '.bastion/acceptance.md': ACCEPTANCE },
    });
    const { result, err } = await captureConsole(() => runQa({ cwd: repo }));
    assert.equal(result, 0, err);
    assert.equal(qaCalls(repo).length, 1);
    assert.doesNotMatch(err, /run-state|bastion run/i, 'a missing run-state is not an error any more');
    assert.equal(fs.existsSync(path.join(repo, '.bastion', 'run-state.json')), false);
  });

  it('v1.1: a missing acceptance.md is not an error - the role is called and the acceptance section is left out', async () => {
    const repo = await createCompletedRun({ verdict: 'pass', findings: [] });
    fs.rmSync(path.join(repo, '.bastion', 'acceptance.md'));
    const { result, err } = await captureConsole(() => runQa({ cwd: repo }));
    assert.equal(result, 0, err);
    assert.equal(qaCalls(repo).length, 1);
    assert.ok(!qaCalls(repo)[0].prompt.includes('## Acceptance (acceptance.md)'));
    assert.deepEqual(completed(repo).sort(), ['n1', 'n2']);
  });

  it('pass: returns 0, changes nothing, and tells the role the acceptance list', async () => {
    const repo = await createCompletedRun({ verdict: 'pass', findings: [] });
    const { result } = await captureConsole(() => runQa({ cwd: repo }));
    assert.equal(result, 0);
    assert.deepEqual(completed(repo).sort(), ['n1', 'n2']);
    assert.equal(fs.existsSync(path.join(repo, '.bastion', 'feedback')) && fs.readdirSync(path.join(repo, '.bastion', 'feedback')).length > 0, false);
    assert.equal(fs.existsSync(path.join(repo, QA_DISPUTES_REL_PATH)), false);
    assert.ok(fs.existsSync(path.join(repo, QA_REPORT_REL_PATH)), 'report is left at .bastion/qa.json');
    const calls = qaCalls(repo);
    assert.equal(calls.length, 1);
    assert.match(calls[0].prompt, /add\(2, 3\) is 5/);
    assert.match(calls[0].prompt, /mul\(4, 5\) is 20/);
  });

  it('invalid report: returns 1 and reopens nothing', async () => {
    for (const bad of [{ verdict: 'fail' }, { verdict: 'fail', findings: [{ node: 'n1', kind: 'nope', issue: 'x' }] }, 'garbage']) {
      const repo = await createCompletedRun(bad);
      const { result } = await captureConsole(() => runQa({ cwd: repo }));
      assert.equal(result, 1);
      assert.equal(qaCalls(repo).length, 1, 'the qa role was actually called');
      assert.deepEqual(completed(repo).sort(), ['n1', 'n2']);
      assert.equal(fs.existsSync(feedbackPath(repo, 'n1')), false);
      assert.equal(fs.existsSync(feedbackPath(repo, 'n2')), false);
      assert.equal(fs.existsSync(path.join(repo, QA_DISPUTES_REL_PATH)), false);
    }
  });

  it('role that writes no report: returns 1 and reopens nothing', async () => {
    const repo = await createCompletedRun(undefined);
    const { result } = await captureConsole(() => runQa({ cwd: repo }));
    assert.equal(result, 1);
    assert.equal(qaCalls(repo).length, 1, 'the qa role was actually called');
    assert.deepEqual(completed(repo).sort(), ['n1', 'n2']);
  });

  it('fail with a code finding: reopens only that node, writes its feedback, returns 1 and says what to do', async () => {
    const issue = 'mul(0, 5) must be 0 but loops forever on negative b';
    const repo = await createCompletedRun({ verdict: 'fail', findings: [{ node: 'n2', kind: 'code', issue }] });
    const { result, out, err } = await captureConsole(() => runQa({ cwd: repo }));
    assert.equal(result, 1);
    assert.deepEqual(completed(repo), ['n1']);
    assert.ok(fs.existsSync(feedbackPath(repo, 'n2')));
    assert.ok(fs.readFileSync(feedbackPath(repo, 'n2'), 'utf8').includes(issue));
    assert.equal(fs.existsSync(feedbackPath(repo, 'n1')), false);
    assert.equal(fs.existsSync(path.join(repo, QA_DISPUTES_REL_PATH)), false);
    assert.match(out + err, /run --resume/);
  });

  it('feedback is appended, not overwritten, across qa runs and several findings for one node', async () => {
    const repo = await createCompletedRun({
      verdict: 'fail',
      findings: [
        { node: 'n1', kind: 'code', issue: 'FIRST_ISSUE' },
        { node: 'n1', kind: 'code', issue: 'SECOND_ISSUE' },
      ],
    });
    await captureConsole(() => runQa({ cwd: repo }));
    let text = fs.readFileSync(feedbackPath(repo, 'n1'), 'utf8');
    assert.ok(text.includes('FIRST_ISSUE') && text.includes('SECOND_ISSUE'));
    // n1 is reopened but its previous issues must survive a second qa run (n1 is not complete, but state is still valid).
    setFixtures(repo, runFixtures({ verdict: 'fail', findings: [{ node: 'n1', kind: 'code', issue: 'THIRD_ISSUE' }] }));
    await captureConsole(() => runQa({ cwd: repo }));
    text = fs.readFileSync(feedbackPath(repo, 'n1'), 'utf8');
    assert.ok(text.includes('FIRST_ISSUE') && text.includes('SECOND_ISSUE') && text.includes('THIRD_ISSUE'));
    assert.deepEqual(completed(repo), ['n2']);
  });

  it('test_defect findings go to qa-disputes.md only: node stays complete, no feedback, still returns 1', async () => {
    const repo = await createCompletedRun({ verdict: 'fail', findings: [{ node: 'n2', kind: 'test_defect', issue: 'mul test asserts the wrong product' }] });
    const { result, out, err } = await captureConsole(() => runQa({ cwd: repo }));
    assert.equal(result, 1);
    assert.deepEqual(completed(repo).sort(), ['n1', 'n2']);
    assert.equal(fs.existsSync(feedbackPath(repo, 'n2')), false);
    const disputes = fs.readFileSync(path.join(repo, QA_DISPUTES_REL_PATH), 'utf8');
    assert.ok(disputes.includes('n2'));
    assert.ok(disputes.includes('mul test asserts the wrong product'));
    assert.match(out + err, /lock --amend/);
  });

  it('mixed findings are split by kind', async () => {
    const repo = await createCompletedRun({
      verdict: 'fail',
      findings: [
        { node: 'n1', kind: 'code', issue: 'CODE_ISSUE' },
        { node: 'n2', kind: 'test_defect', issue: 'DEFECT_ISSUE' },
      ],
    });
    const { result } = await captureConsole(() => runQa({ cwd: repo }));
    assert.equal(result, 1);
    assert.deepEqual(completed(repo), ['n2']);
    assert.ok(fs.readFileSync(feedbackPath(repo, 'n1'), 'utf8').includes('CODE_ISSUE'));
    assert.ok(!fs.readFileSync(feedbackPath(repo, 'n1'), 'utf8').includes('DEFECT_ISSUE'));
    const disputes = fs.readFileSync(path.join(repo, QA_DISPUTES_REL_PATH), 'utf8');
    assert.ok(disputes.includes('DEFECT_ISSUE') && !disputes.includes('CODE_ISSUE'));
  });
});

describe('v1.0 qa -> run --resume wiring', () => {
  it('the reopened node gets the QA issue in its prompt, only it re-runs, and the feedback file is removed after it passes', async () => {
    const issue = 'MUL_BUG: mul must use multiplication semantics for large b';
    const repo = await createCompletedRun({ verdict: 'fail', findings: [{ node: 'n2', kind: 'code', issue }] });
    const { result: qaResult } = await captureConsole(() => runQa({ cwd: repo }));
    assert.equal(qaResult, 1);
    assert.deepEqual(completed(repo), ['n1']);
    assert.ok(fs.existsSync(feedbackPath(repo, 'n2')));

    const before = readRoleCalls(repo).filter((c) => c.role === 'run' && c.label === 'n1').length;
    setFixtures(repo, runFixtures(undefined, {
      'src/add.mjs': SAMPLE_FILES.impl['src/add.mjs'],
      'src/mul.mjs': "export function mul(a, b) { return a * b; }\n",
    }));
    const { result } = await captureConsole(() =>
      runSwarm({ cwd: repo, baseRef: 'main', agentCommand: 'node scripts/role.mjs', maxRetries: 0, resume: true })
    );
    assert.equal(result, 0);
    const prompt = fs.readFileSync(path.join(repo, '.bastion', 'logs', 'n2-prompt.txt'), 'utf8');
    assert.ok(prompt.includes(issue), 'n2 prompt contains the QA issue');
    assert.equal(readRoleCalls(repo).filter((c) => c.role === 'run' && c.label === 'n1').length, before, 'n1 is not re-run');
    assert.deepEqual(completed(repo).sort(), ['n1', 'n2']);
    assert.equal(fs.existsSync(feedbackPath(repo, 'n2')), false, 'feedback consumed after pass');
  });

  it('feedback survives a resume where the node still fails its gate', async () => {
    const issue = 'STILL_BROKEN_ISSUE';
    const repo = await createCompletedRun({ verdict: 'fail', findings: [{ node: 'n2', kind: 'code', issue }] });
    await captureConsole(() => runQa({ cwd: repo }));
    setFixtures(repo, runFixtures(undefined, {
      'src/add.mjs': SAMPLE_FILES.impl['src/add.mjs'],
      'src/mul.mjs': 'export function mul(a, b) { return 0; }\n',
    }));
    const { result } = await captureConsole(() =>
      runSwarm({ cwd: repo, baseRef: 'main', agentCommand: 'node scripts/role.mjs', maxRetries: 0, resume: true })
    );
    assert.notEqual(result, 0);
    assert.ok(fs.existsSync(feedbackPath(repo, 'n2')));
    assert.ok(fs.readFileSync(feedbackPath(repo, 'n2'), 'utf8').includes(issue));
    assert.deepEqual(completed(repo), ['n1']);
  });
});
