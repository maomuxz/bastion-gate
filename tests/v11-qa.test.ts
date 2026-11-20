// v1.1 - `bastion qa` really runs the product: parseQaReport cases, detached QA worktree, black-box cases run by bastion.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { parseQaReport, runQa } from '../src/commands/qa.js';
import { runLock } from '../src/commands/lock.js';
import { runSwarm } from '../src/commands/run.js';
import { QA_CASES_REL_DIR, QA_REPORT_REL_PATH, QA_RUN_REL_PATH } from '../src/commands/stages.js';
import type { QaCase, QaCaseRun } from '../src/commands/stages.js';
import { captureConsole, cleanupTempRepos, git, readJson, writeRepoFile } from './v04-helpers.js';
import { createRoleRepo, readRoleCalls, SAMPLE_FILES, sampleMap, setFixtures } from './v1-helpers.js';
import type { RoleFixture, RoleFixtures } from './v1-helpers.js';

afterEach(cleanupTempRepos);

const ACCEPTANCE = '# Acceptance\n\n## n1 Add\n- add(2, 3) is 5\n\n## n2 Mul\n- mul(4, 5) is 20\n';
const REQUIREMENT = '# Calculator\n\nThe tool must add and mul.\n\n- rule A: add(2, 3) is 5\n- rule B: mul by zero is 0\n';
const WORKTREE_REL = path.join('.bastion', 'worktrees', 'qa');

// Case scripts (written by the fake qa role into its cwd, i.e. the QA worktree).
const CASE_FILES: Record<string, string> = {
  // Only passes in a checkout of the integration branch (the main checkout still has the stubs).
  '.bastion/qa-cases/add.mjs': "import { add } from '../../src/add.mjs';\nprocess.exit(add(2, 3) === 5 ? 0 : 1);\n",
  '.bastion/qa-cases/ok.mjs': "console.log('ok-output');\nprocess.exit(0);\n",
  '.bastion/qa-cases/bad.mjs': "console.log('BOOM_STDOUT');\nconsole.error('BOOM_STDERR');\nprocess.exit(1);\n",
  '.bastion/qa-cases/seven.mjs': 'process.exit(7);\n',
  '.bastion/qa-cases/noisy.mjs': "console.log('a'.repeat(6000));\nconsole.error('TAIL_END_MARK');\nprocess.exit(1);\n",
  // Sequential order: first writes order.txt, second fails unless it already exists with 'a'.
  '.bastion/qa-cases/first.mjs': "import * as fs from 'node:fs';\nfs.writeFileSync('order.txt', 'a');\n",
  '.bastion/qa-cases/second.mjs': "import * as fs from 'node:fs';\nprocess.exit(fs.existsSync('order.txt') && fs.readFileSync('order.txt', 'utf8') === 'a' ? 0 : 1);\n",
  // Setup / stale worktree probes.
  '.bastion/qa-cases/setup.mjs': "import * as fs from 'node:fs';\nprocess.exit(fs.existsSync('setup-ran.txt') ? 0 : 1);\n",
  '.bastion/qa-cases/nostale.mjs': "import * as fs from 'node:fs';\nprocess.exit(fs.existsSync('stale.txt') ? 1 : 0);\n",
};
const mk = (name: string, node = 'n1', script = name, rule = `rule of ${name}`): QaCase => ({
  name,
  rule,
  node,
  command: `node .bastion/qa-cases/${script}.mjs`,
});
const C_ADD = mk('add-case', 'n1', 'add');
const C_OK = mk('ok-case', 'n2', 'ok');
const C_BAD = mk('bad-case', 'n2', 'bad', 'mul stays a product');
const PASS = { verdict: 'pass', findings: [] as unknown[] };

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

/** A locked repo whose two nodes were built by `bastion run`; the qa role behaves as `qa` (case scripts always available). */
async function createCompletedRun(qa: RoleFixture | undefined): Promise<string> {
  const map = sampleMap();
  const fixtures: RoleFixtures = {
    run: {
      byLabel: {
        n1: { files: { 'src/add.mjs': SAMPLE_FILES.impl['src/add.mjs'] } },
        n2: { files: { 'src/mul.mjs': SAMPLE_FILES.impl['src/mul.mjs'] } },
      },
    },
    ...(qa ? { qa: { ...qa, files: { ...CASE_FILES, ...(qa.files ?? {}) } } } : {}),
  };
  const repo = createRoleRepo({
    fixtures,
    files: {
      ...SAMPLE_FILES.stubs,
      ...SAMPLE_FILES.tests,
      'scripts/setup.mjs': "import * as fs from 'node:fs';\nfs.writeFileSync('setup-ran.txt', '1');\n",
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
  git(['checkout', 'main'], repo); // the run leaves the main checkout on the integration branch; qa must not depend on that
  return repo;
}

const qaReport = (cases: QaCase[], extra: Record<string, unknown> = {}) => ({ output: { ...PASS, ...extra, cases } });

function completed(repo: string): string[] {
  return readJson<{ completedNodes: string[] }>(path.join(repo, '.bastion', 'run-state.json')).completedNodes;
}
const feedbackPath = (repo: string, id: string) => path.join(repo, '.bastion', 'feedback', `${id}.md`);
const qaCalls = (repo: string) => readRoleCalls(repo).filter((c) => c.role === 'qa');
const runFile = (repo: string) => {
  assert.ok(fs.existsSync(path.join(repo, QA_RUN_REL_PATH)), 'qa-run.json is written');
  return readJson<QaCaseRun[]>(path.join(repo, QA_RUN_REL_PATH));
};
const readFb = (repo: string, id: string) => {
  assert.ok(fs.existsSync(feedbackPath(repo, id)), `feedback/${id}.md exists`);
  return fs.readFileSync(feedbackPath(repo, id), 'utf8');
};
const worktreeGone = (repo: string) => {
  assert.equal(fs.existsSync(path.join(repo, WORKTREE_REL)), false, 'QA worktree directory is removed');
  assert.ok(!git(['worktree', 'list'], repo).replace(/\\/g, '/').includes('worktrees/qa'), 'QA worktree is unregistered');
};

describe('v1.1 parseQaReport cases', () => {
  it('a missing cases key gives []; valid cases come back intact', () => {
    assert.deepEqual(parseQaReport({ verdict: 'pass', findings: [] }), { verdict: 'pass', findings: [], cases: [] });
    const cases = [C_ADD, C_BAD];
    const finding = { node: 'n2', kind: 'code', issue: 'x' };
    assert.deepEqual(parseQaReport({ verdict: 'fail', findings: [finding], cases }), { verdict: 'fail', findings: [finding], cases });
    assert.deepEqual(parseQaReport({ verdict: 'pass', findings: [], cases: [] })?.cases, []);
  });

  it('any malformed cases value invalidates the whole report', () => {
    const ok = { name: 'n', rule: 'r', node: 'n1', command: 'c' };
    const bad: unknown[] = [
      'cases', 5, {}, { 0: ok }, null,
      [null], ['x'], [[ok]],
      [{ ...ok, name: undefined }], [{ ...ok, rule: undefined }], [{ ...ok, node: undefined }], [{ ...ok, command: undefined }],
      [{ ...ok, name: '' }], [{ ...ok, rule: '' }], [{ ...ok, node: '' }], [{ ...ok, command: '' }],
      [{ ...ok, name: 1 }], [{ ...ok, rule: ['r'] }], [{ ...ok, node: null }], [{ ...ok, command: { cmd: 'c' } }],
      [ok, { ...ok, command: '' }],
    ];
    for (const cases of bad) {
      assert.equal(parseQaReport({ verdict: 'pass', findings: [], cases }), null, `should reject cases ${JSON.stringify(cases)}`);
    }
  });
});

describe('v1.1 runQa prompt', () => {
  it('carries the requirement verbatim, the acceptance, the changed-file list - and no line of the implementation diff', async () => {
    const repo = await createCompletedRun(qaReport([C_ADD]));
    writeRepoFile(repo, '.bastion/requirement.md', REQUIREMENT);
    const { result } = await captureConsole(() => runQa({ cwd: repo }));
    assert.equal(result, 0);
    const calls = qaCalls(repo);
    assert.equal(calls.length, 1);
    const prompt = calls[0].prompt;
    assert.ok(prompt.includes('## Original requirement (source of truth)'));
    assert.ok(prompt.includes(REQUIREMENT), 'requirement.md is embedded verbatim');
    assert.ok(prompt.includes('## Acceptance (acceptance.md)'));
    assert.ok(prompt.includes('add(2, 3) is 5') && prompt.includes('mul(4, 5) is 20'));
    assert.ok(prompt.indexOf('Original requirement') < prompt.indexOf('## Acceptance'), 'requirement comes first');
    const at = prompt.indexOf('## Changed files');
    assert.ok(at > -1, 'has a Changed files section');
    const changed = prompt.slice(at);
    assert.ok(changed.includes('src/add.mjs') && changed.includes('src/mul.mjs'), 'lists the files changed on the integration branch');
    assert.ok(/\|\s*\d+/.test(changed), 'is the output of git diff --stat');
    assert.ok(!prompt.includes('diff --git'), 'no raw diff');
    assert.ok(!prompt.includes('+export function add(a, b) { return a + b; }'), 'no added implementation line');
    assert.ok(!prompt.includes('for (let i = 0; i < b; i++)'), 'no implementation body of mul');
    assert.ok(!prompt.includes('## Integration diff'));
    assert.ok(prompt.includes('.bastion/qa-cases'), 'tells the role where to write case scripts');
  });

  it('leaves the requirement section out when requirement.md is missing or blank', async () => {
    const repo = await createCompletedRun(qaReport([C_ADD]));
    assert.equal((await captureConsole(() => runQa({ cwd: repo }))).result, 0);
    assert.equal(qaCalls(repo).length, 1);
    assert.ok(!qaCalls(repo)[0].prompt.includes('Original requirement'), 'missing file');
    assert.ok(qaCalls(repo)[0].prompt.includes('## Changed files'), 'rest of the prompt is still there');

    writeRepoFile(repo, '.bastion/requirement.md', '  \n\n \t\n');
    assert.equal((await captureConsole(() => runQa({ cwd: repo }))).result, 0);
    assert.equal(qaCalls(repo).length, 2);
    assert.ok(!qaCalls(repo)[1].prompt.includes('Original requirement'), 'blank file');
  });
});

describe('v1.1 runQa checkout and evidence', () => {
  it('runs the role in a worktree of the integration branch, not in the main checkout', async () => {
    const repo = await createCompletedRun(qaReport([C_ADD], { }));
    // The fixture role also drops a marker into its cwd.
    const fx = readJson<RoleFixtures>(path.join(repo, 'role-fixtures.json'));
    fx.qa!.files!['qa-marker.txt'] = 'written by the role';
    writeRepoFile(repo, 'role-fixtures.json', JSON.stringify(fx));
    git(['add', 'role-fixtures.json'], repo);
    git(['commit', '-m', 'chore: marker'], repo);

    assert.ok(fs.readFileSync(path.join(repo, 'src', 'add.mjs'), 'utf8').includes('return 0'), 'main checkout still has the stub');
    const { result } = await captureConsole(() => runQa({ cwd: repo }));
    assert.equal(result, 0, 'the case only passes against the integration code (cwd of the case is the worktree)');
    assert.equal(fs.existsSync(path.join(repo, 'qa-marker.txt')), false, 'role cwd is not the main checkout');
    assert.equal(git(['status', '--porcelain', '--', 'qa-marker.txt', 'src'], repo), '');
    assert.ok(fs.readFileSync(path.join(repo, 'src', 'add.mjs'), 'utf8').includes('return 0'), 'main checkout untouched');
    worktreeGone(repo);
  });

  it('a report without cases is refused with the dedicated message, even when it says pass', async () => {
    for (const fixture of [{ output: PASS }, qaReport([])]) {
      const repo = await createCompletedRun(fixture);
      const { result, err } = await captureConsole(() => runQa({ cwd: repo }));
      assert.equal(result, 1);
      assert.equal(qaCalls(repo).length, 1, 'the role was called');
      assert.ok(err.includes('[bastion] qa: the qa role ran no black-box case.'), err);
      assert.equal(fs.existsSync(path.join(repo, QA_RUN_REL_PATH)), false, 'nothing was run');
      assert.deepEqual(completed(repo).sort(), ['n1', 'n2']);
      worktreeGone(repo);
    }
  });

  it('a case with a missing field makes the report invalid: 1, nothing reopened, worktree removed', async () => {
    const repo = await createCompletedRun({ output: { ...PASS, cases: [{ name: 'x', rule: 'r', node: 'n1' }] } });
    const { result } = await captureConsole(() => runQa({ cwd: repo }));
    assert.equal(result, 1);
    assert.deepEqual(completed(repo).sort(), ['n1', 'n2']);
    assert.equal(fs.existsSync(path.join(repo, QA_RUN_REL_PATH)), false);
    worktreeGone(repo);
  });

  it('role exit != 0 returns 1 and still removes the worktree', async () => {
    const repo = await createCompletedRun({ ...qaReport([C_ADD]), exit: 2 });
    const { result } = await captureConsole(() => runQa({ cwd: repo }));
    assert.equal(result, 1);
    assert.deepEqual(completed(repo).sort(), ['n1', 'n2']);
    worktreeGone(repo);
  });

  it('replaces a stale worktree left by a crashed run', async () => {
    const repo = await createCompletedRun(qaReport([C_ADD, mk('nostale', 'n1')]));
    git(['worktree', 'add', '--detach', WORKTREE_REL, 'HEAD'], repo);
    fs.writeFileSync(path.join(repo, WORKTREE_REL, 'stale.txt'), 'leftover');
    const { result } = await captureConsole(() => runQa({ cwd: repo }));
    assert.equal(result, 0, 'stale content must not be visible to the cases');
    worktreeGone(repo);
  });

  it('runs config.setupCommand in the worktree before the role; a failing setup returns 1 without calling the role', async () => {
    const repo = await createCompletedRun(qaReport([mk('setup-case', 'n1', 'setup')]));
    const cfgPath = path.join(repo, '.bastion', 'config.json');
    const cfg = readJson<Record<string, unknown>>(cfgPath);
    fs.writeFileSync(cfgPath, JSON.stringify({ ...cfg, setupCommand: 'node scripts/setup.mjs' }, null, 2));
    const { result } = await captureConsole(() => runQa({ cwd: repo }));
    assert.equal(result, 0, 'setup output is visible to the case');
    assert.equal(fs.existsSync(path.join(repo, 'setup-ran.txt')), false, 'setup ran in the worktree, not the main checkout');
    worktreeGone(repo);

    const before = qaCalls(repo).length;
    fs.writeFileSync(cfgPath, JSON.stringify({ ...cfg, setupCommand: 'node -e "process.exit(3)"' }, null, 2));
    const failed = await captureConsole(() => runQa({ cwd: repo }));
    assert.equal(failed.result, 1);
    assert.equal(qaCalls(repo).length, before, 'role not called after a failed setup');
    worktreeGone(repo);
  });
});

describe('v1.1 runQa runs the cases itself', () => {
  it('all cases exit 0 -> 0, prints the count, writes qa-run.json and leaves the run untouched', async () => {
    const repo = await createCompletedRun(qaReport([C_ADD, C_OK]));
    const { result, out } = await captureConsole(() => runQa({ cwd: repo }));
    assert.equal(result, 0);
    assert.ok(out.includes('[bastion] qa: pass (2 case(s) run).'), out);
    assert.deepEqual(completed(repo).sort(), ['n1', 'n2']);
    assert.equal(fs.existsSync(path.join(repo, '.bastion', 'feedback')) && fs.readdirSync(path.join(repo, '.bastion', 'feedback')).length > 0, false);

    const runs = runFile(repo);
    assert.equal(runs.length, 2);
    assert.deepEqual(runs.map(({ outputTail: _t, ...rest }) => rest), [
      { ...C_ADD, exitCode: 0, timedOut: false },
      { ...C_OK, exitCode: 0, timedOut: false },
    ]);
    assert.ok(runs[1].outputTail.includes('ok-output'));
    assert.ok(fs.existsSync(path.join(repo, QA_REPORT_REL_PATH)), 'report copied to the main checkout');
    assert.deepEqual(readJson<{ cases: QaCase[] }>(path.join(repo, QA_REPORT_REL_PATH)).cases, [C_ADD, C_OK]);
    worktreeGone(repo);
  });

  it('copies .bastion/qa-cases to the main checkout and replaces an old copy', async () => {
    const repo = await createCompletedRun(qaReport([C_ADD, C_OK]));
    writeRepoFile(repo, `${QA_CASES_REL_DIR}/old.mjs`, '// from an earlier qa run\n');
    const { result } = await captureConsole(() => runQa({ cwd: repo }));
    assert.equal(result, 0);
    const dir = path.join(repo, QA_CASES_REL_DIR);
    assert.equal(fs.readFileSync(path.join(dir, 'add.mjs'), 'utf8'), CASE_FILES['.bastion/qa-cases/add.mjs']);
    assert.equal(fs.readFileSync(path.join(dir, 'ok.mjs'), 'utf8'), CASE_FILES['.bastion/qa-cases/ok.mjs']);
    assert.equal(fs.existsSync(path.join(dir, 'old.mjs')), false, 'old copy replaced, not merged');
  });

  it('a pass report whose case exits 1 does not pass: returns 1, reopens the node, feedback names the case, records the run', async () => {
    const repo = await createCompletedRun(qaReport([C_ADD, C_BAD]));
    const { result, out, err } = await captureConsole(() => runQa({ cwd: repo }));
    assert.equal(result, 1);
    assert.ok(!out.includes('qa: pass'), 'no pass message');
    assert.deepEqual(completed(repo), ['n1'], 'only the node of the failing case is reopened');
    const fb = readFb(repo, 'n2');
    assert.ok(fb.includes(C_BAD.name), fb);
    assert.ok(fb.includes(`black-box case "bad-case" failed (mul stays a product): node .bastion/qa-cases/bad.mjs exited 1`), fb);
    assert.ok(fb.includes('BOOM_STDOUT') && fb.includes('BOOM_STDERR'), 'output tail is in the feedback');
    assert.equal(fs.existsSync(feedbackPath(repo, 'n1')), false);
    assert.match(out + err, /run --resume/);

    const runs = runFile(repo);
    assert.equal(runs.length, 2, 'every case is recorded, also the ones after a failure and before it');
    assert.equal(runs[0].exitCode, 0);
    assert.equal(runs[1].exitCode, 1);
    assert.equal(runs[1].timedOut, false);
    assert.ok(runs[1].outputTail.includes('BOOM_STDOUT') && runs[1].outputTail.includes('BOOM_STDERR'));
    assert.ok(fs.existsSync(path.join(repo, QA_CASES_REL_DIR, 'bad.mjs')), 'cases are kept for the failing path too');
    worktreeGone(repo);
  });

  it('records the real exit code and keeps only the last 2000 chars of the output', async () => {
    const repo = await createCompletedRun(qaReport([mk('seven', 'n1'), mk('noisy', 'n2')]));
    const { result } = await captureConsole(() => runQa({ cwd: repo }));
    assert.equal(result, 1);
    const runs = runFile(repo);
    assert.equal(runs[0].exitCode, 7);
    assert.ok(readFb(repo, 'n1').includes('exited 7'));
    assert.ok(runs[1].outputTail.length <= 2000, `tail is ${runs[1].outputTail.length} chars`);
    assert.ok(runs[1].outputTail.length >= 1000, 'a real tail, not an empty string');
    assert.ok(runs[1].outputTail.includes('TAIL_END_MARK'), 'the end of the output is kept');
    assert.deepEqual(completed(repo), [], 'both nodes reopened');
  });

  it('runs cases sequentially in the order of the report, through a shell', async () => {
    const chained = { name: 'chained', rule: 'shell operators', node: 'n1', command: 'node .bastion/qa-cases/ok.mjs && node .bastion/qa-cases/ok.mjs' };
    const repo = await createCompletedRun(qaReport([mk('first', 'n1'), mk('second', 'n2'), chained]));
    const { result } = await captureConsole(() => runQa({ cwd: repo }));
    assert.equal(result, 0, '"second" needs the file "first" wrote, "chained" needs a shell for &&');
    assert.deepEqual(runFile(repo).map((c) => c.name), ['first', 'second', 'chained']);
    assert.equal(runFile(repo)[2].outputTail.split('ok-output').length - 1, 2, 'both halves of the && chain ran');
  });

  it('does not duplicate a code finding the report already has for the node, but still adds cases of other nodes', async () => {
    const repo = await createCompletedRun(qaReport([C_BAD, mk('bad-n1', 'n1', 'bad')], {
      verdict: 'fail',
      findings: [{ node: 'n2', kind: 'code', issue: 'ROLE_FINDING_N2' }],
    }));
    const { result } = await captureConsole(() => runQa({ cwd: repo }));
    assert.equal(result, 1);
    const n2 = readFb(repo, 'n2');
    assert.ok(n2.includes('ROLE_FINDING_N2'));
    assert.ok(!n2.includes('black-box case'), 'no second finding for n2: ' + n2);
    assert.equal(n2.split('\n').filter((l) => l.trim()).length, 1, 'exactly one issue line for n2');
    assert.ok(readFb(repo, 'n1').includes('bad-n1'), 'n1 had no finding, so its failing case is added');
    assert.deepEqual(completed(repo), []);
  });

  it('a test_defect finding does not suppress the finding of a failing case on the same node', async () => {
    const repo = await createCompletedRun(qaReport([C_BAD], {
      verdict: 'fail',
      findings: [{ node: 'n2', kind: 'test_defect', issue: 'DEFECT_N2' }],
    }));
    const { result } = await captureConsole(() => runQa({ cwd: repo }));
    assert.equal(result, 1);
    assert.ok(readFb(repo, 'n2').includes('bad-case'));
    assert.deepEqual(completed(repo), ['n1']);
    assert.ok(fs.readFileSync(path.join(repo, '.bastion', 'qa-disputes.md'), 'utf8').includes('DEFECT_N2'));
  });

  it('the role verdict cannot override a finding: pass + code finding + green cases is still a fail', async () => {
    const repo = await createCompletedRun(qaReport([C_ADD, C_OK], { findings: [{ node: 'n1', kind: 'code', issue: 'PASS_BUT_FINDING' }] }));
    const { result, out } = await captureConsole(() => runQa({ cwd: repo }));
    assert.equal(result, 1);
    assert.ok(!out.includes('qa: pass'));
    assert.deepEqual(completed(repo), ['n2']);
    assert.ok(readFb(repo, 'n1').includes('PASS_BUT_FINDING'));
    assert.equal(runFile(repo).length, 2, 'cases still ran');
    worktreeGone(repo);
  });

  it('a failed qa after reopening feeds `run --resume` with the case failure', async () => {
    const repo = await createCompletedRun(qaReport([C_BAD]));
    assert.equal((await captureConsole(() => runQa({ cwd: repo }))).result, 1);
    // the resumed node must produce a real change, otherwise there is nothing to commit
    // commit the new fixtures on the integration branch: resume builds the node worktree from it
    git(['checkout', JSON.parse(fs.readFileSync(path.join(repo, '.bastion', 'run-state.json'), 'utf8')).integrationBranch], repo);
    setFixtures(repo, { run: { byLabel: {
      n1: { files: { 'src/add.mjs': SAMPLE_FILES.impl['src/add.mjs'] } },
      n2: { files: { 'src/mul.mjs': 'export function mul(a, b) { return a * b; }\n' } },
    } } });
    const { result } = await captureConsole(() =>
      runSwarm({ cwd: repo, baseRef: 'main', agentCommand: 'node scripts/role.mjs', maxRetries: 0, resume: true })
    );
    assert.equal(result, 0);
    const prompt = fs.readFileSync(path.join(repo, '.bastion', 'logs', 'n2-prompt.txt'), 'utf8');
    assert.ok(prompt.includes('bad-case'), 'the n2 prompt carries the case failure');
  });
});
