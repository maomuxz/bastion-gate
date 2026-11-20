// v1.1 hardening (round 5) - qa: Q1 the role must not change the checkout it judges, Q2 a 'fail' verdict without findings still fails.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { runQa } from '../src/commands/qa.js';
import { runLock } from '../src/commands/lock.js';
import { runSwarm } from '../src/commands/run.js';
import { QA_REPORT_REL_PATH, QA_RUN_REL_PATH } from '../src/commands/stages.js';
import type { QaCase } from '../src/commands/stages.js';
import { captureConsole, cleanupTempRepos, git, readJson } from './v04-helpers.js';
import { createRoleRepo, SAMPLE_FILES, sampleMap } from './v1-helpers.js';
import type { RoleFixture, RoleFixtures } from './v1-helpers.js';

afterEach(cleanupTempRepos);

const ACCEPTANCE = '# Acceptance\n\n## n1 Add\n- add(2, 3) is 5\n\n## n2 Mul\n- mul(4, 5) is 20\n';
const WORKTREE_REL = path.join('.bastion', 'worktrees', 'qa');

const CASE_FILES: Record<string, string> = {
  '.bastion/qa-cases/ok.mjs': "console.log('ok-output');\nprocess.exit(0);\n",
  // Pass ONLY when the role has tampered with the checkout (the real product has add(2, 3) === 5, mul present, no helper.txt).
  '.bastion/qa-cases/wants-add-9.mjs': "import { add } from '../../src/add.mjs';\nprocess.exit(add(2, 3) === 9 ? 0 : 1);\n",
  '.bastion/qa-cases/wants-helper.mjs': "import * as fs from 'node:fs';\nprocess.exit(fs.existsSync('helper.txt') ? 0 : 1);\n",
  '.bastion/qa-cases/wants-no-mul.mjs': "import * as fs from 'node:fs';\nprocess.exit(fs.existsSync('src/mul.mjs') ? 1 : 0);\n",
};
const mk = (name: string, node: string, script: string): QaCase => ({
  name,
  rule: `rule of ${name}`,
  node,
  command: `node .bastion/qa-cases/${script}.mjs`,
});
const C_OK = mk('ok-case', 'n1', 'ok');
const C_ADD9 = mk('add9-case', 'n1', 'wants-add-9');
const C_HELPER = mk('helper-case', 'n1', 'wants-helper');
const C_NOMUL = mk('nomul-case', 'n2', 'wants-no-mul');

// A qa role that deletes a tracked product file first, then behaves as the fake role script.
const DELETE_ROLE = [
  "import * as fs from 'node:fs';",
  "fs.rmSync('src/mul.mjs');",
  "await import('./role.mjs');",
].join('\n') + '\n';

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

/** A locked repo whose two nodes were built by `bastion run`; the qa role behaves as `qa`. */
async function createCompletedRun(qa: RoleFixture, qaCommand?: string): Promise<string> {
  const map = sampleMap();
  const fixtures: RoleFixtures = {
    run: {
      byLabel: {
        n1: { files: { 'src/add.mjs': SAMPLE_FILES.impl['src/add.mjs'] } },
        n2: { files: { 'src/mul.mjs': SAMPLE_FILES.impl['src/mul.mjs'] } },
      },
    },
    qa: { ...qa, files: { ...CASE_FILES, ...(qa.files ?? {}) } },
  };
  const repo = createRoleRepo({
    fixtures,
    files: {
      ...SAMPLE_FILES.stubs,
      ...SAMPLE_FILES.tests,
      'scripts/qa-delete.mjs': DELETE_ROLE,
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
  git(['checkout', 'main'], repo);
  if (qaCommand) {
    const cfgPath = path.join(repo, '.bastion', 'config.json');
    const cfg = readJson<{ roles: Record<string, string> }>(cfgPath);
    fs.writeFileSync(cfgPath, JSON.stringify({ ...cfg, roles: { ...cfg.roles, qa: qaCommand } }, null, 2) + '\n');
  }
  return repo;
}

const report = (cases: QaCase[], extra: Record<string, unknown> = {}): RoleFixture => ({
  output: { verdict: 'pass', findings: [], ...extra, cases },
});

function completed(repo: string): string[] {
  return readJson<{ completedNodes: string[] }>(path.join(repo, '.bastion', 'run-state.json')).completedNodes.slice().sort();
}
function noFeedback(repo: string): void {
  const dir = path.join(repo, '.bastion', 'feedback');
  assert.equal(fs.existsSync(dir) && fs.readdirSync(dir).length > 0, false, 'no feedback file is written');
}
function worktreeGone(repo: string): void {
  assert.equal(fs.existsSync(path.join(repo, WORKTREE_REL)), false, 'QA worktree directory is removed');
}
const TAMPER_RE = /\[bastion\] qa: the qa role changed files in the checkout: (.+?)\. QA must not edit the product; no case was run\./;

/** Run qa and assert the Q1 refusal; returns the paths named in the stderr line. */
async function expectTamperRefused(repo: string): Promise<string[]> {
  const before = completed(repo);
  const { result, err, out } = await captureConsole(() => runQa({ cwd: repo }));
  assert.equal(result, 1, 'a tampering qa role must fail the run');
  assert.ok(!out.includes('qa: pass'), out);
  const m = TAMPER_RE.exec(err);
  assert.ok(m, `stderr names the changed paths: ${err}`);
  assert.equal(fs.existsSync(path.join(repo, QA_RUN_REL_PATH)), false, 'no case was run: no qa-run.json');
  noFeedback(repo);
  assert.deepEqual(completed(repo), before, 'run-state untouched');
  worktreeGone(repo);
  return m![1].split(', ');
}

describe('v1.1 hardening Q1: the qa role must not change the checkout', () => {
  it('modifying a tracked product file is refused even though the case only passes thanks to it', async () => {
    const repo = await createCompletedRun({
      ...report([C_ADD9]),
      files: { 'src/add.mjs': 'export function add(a, b) { return 9; }\n' },
    });
    assert.deepEqual(await expectTamperRefused(repo), ['src/add.mjs']);
  });

  it('adding an untracked file outside .bastion is refused', async () => {
    const repo = await createCompletedRun({ ...report([C_HELPER]), files: { 'helper.txt': 'planted' } });
    assert.deepEqual(await expectTamperRefused(repo), ['helper.txt']);
  });

  it('deleting a tracked file is refused', async () => {
    const repo = await createCompletedRun(report([C_NOMUL]), 'node scripts/qa-delete.mjs');
    assert.deepEqual(await expectTamperRefused(repo), ['src/mul.mjs']);
  });

  it('names only the product paths when the role also wrote under .bastion/', async () => {
    const repo = await createCompletedRun({
      ...report([C_ADD9]),
      files: { 'src/add.mjs': 'export function add(a, b) { return 9; }\n', '.bastion/notes.md': 'scratch' },
    });
    const paths = await expectTamperRefused(repo);
    assert.deepEqual(paths, ['src/add.mjs']);
  });

  it('lists at most 5 paths', async () => {
    const files: Record<string, string> = {};
    for (let i = 1; i <= 8; i++) files[`stray${i}.txt`] = 'x';
    const repo = await createCompletedRun({ ...report([C_OK]), files });
    const paths = await expectTamperRefused(repo);
    assert.equal(paths.length, 5, `exactly 5 of the 8 paths: ${paths.join(', ')}`);
    for (const p of paths) assert.match(p, /^stray[1-8]\.txt$/);
  });

  it('a role that only writes under .bastion/ still passes', async () => {
    const repo = await createCompletedRun({
      ...report([C_OK]),
      files: { '.bastion/notes.md': 'scratch', '.bastion/qa-cases/extra.mjs': 'process.exit(0);\n' },
    });
    const { result, out } = await captureConsole(() => runQa({ cwd: repo }));
    assert.equal(result, 0);
    assert.ok(out.includes('[bastion] qa: pass (1 case(s) run).'), out);
    assert.ok(fs.existsSync(path.join(repo, QA_RUN_REL_PATH)));
    worktreeGone(repo);
  });
});

describe('v1.1 hardening Q2: a fail verdict without findings still fails', () => {
  const Q2_LINE = "[bastion] qa: the qa role's verdict is fail but it reported no finding; read .bastion/qa-report.json.";

  it('verdict fail, no findings, a passing case -> 1 with the stderr line, files written, nothing reopened', async () => {
    const repo = await createCompletedRun(report([C_OK], { verdict: 'fail' }));
    const { result, err, out } = await captureConsole(() => runQa({ cwd: repo }));
    assert.equal(result, 1);
    assert.ok(err.includes(Q2_LINE), err);
    assert.ok(!out.includes('qa: pass'), out);
    assert.ok(fs.existsSync(path.join(repo, QA_RUN_REL_PATH)), 'qa-run.json is written');
    assert.equal(readJson<unknown[]>(path.join(repo, QA_RUN_REL_PATH)).length, 1);
    assert.ok(fs.existsSync(path.join(repo, QA_REPORT_REL_PATH)), 'the report is written');
    assert.equal(readJson<{ verdict: string }>(path.join(repo, QA_REPORT_REL_PATH)).verdict, 'fail');
    noFeedback(repo);
    assert.deepEqual(completed(repo), ['n1', 'n2'], 'run-state untouched');
    worktreeGone(repo);
  });

  it('verdict pass, no findings, a passing case -> 0 without the line', async () => {
    const repo = await createCompletedRun(report([C_OK]));
    const { result, err } = await captureConsole(() => runQa({ cwd: repo }));
    assert.equal(result, 0);
    assert.ok(!err.includes('verdict is fail'), err);
  });

  it('a fail verdict that comes with a code finding is the ordinary failure, not the Q2 line', async () => {
    const repo = await createCompletedRun(
      report([C_OK], { verdict: 'fail', findings: [{ node: 'n2', kind: 'code', issue: 'REAL_FINDING' }] })
    );
    const { result, err } = await captureConsole(() => runQa({ cwd: repo }));
    assert.equal(result, 1);
    assert.ok(!err.includes('reported no finding'), err);
    assert.deepEqual(completed(repo), ['n1'], 'n2 reopened');
  });
});
