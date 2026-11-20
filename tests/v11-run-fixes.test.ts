// v1.1 run fixes: baseline drift stops for a human, attempt logs are never overwritten, run-state extraDeps,
// and commits/merges that work without a git identity.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { BASELINE_FILES, baselineDrift, driftMessage } from '../src/baseline.js';
import { EXIT_WAITING, runSwarm } from '../src/commands/run.js';
import { execGit, resolveRef } from '../src/git.js';
import { createNodeWorktree, mergeNodeBranch } from '../src/orchestrator/worktree.js';
import { readRunState, RunState } from '../src/state.js';
import {
  AGENT_PRELUDE,
  captureConsole,
  cleanupTempRepos,
  createSwarmRepo,
  createTempGitRepo,
  git,
  readRunStateFile,
  writeRepoFile,
} from './v04-helpers.js';

const extraTemp: string[] = [];
afterEach(() => {
  cleanupTempRepos();
  while (extraTemp.length > 0) fs.rmSync(extraTemp.pop()!, { recursive: true, force: true });
});

/** Run fn with the given env vars set (undefined = unset), restoring afterwards. */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

/** Run fn with no git identity anywhere: unset locally, global/system pointed at temp files, useConfigOnly so git cannot guess one. */
async function withoutGitIdentity<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bastion-v11-noid-'));
  extraTemp.push(dir);
  const globalCfg = path.join(dir, 'global.gitconfig');
  const systemCfg = path.join(dir, 'system.gitconfig');
  fs.writeFileSync(globalCfg, '[user]\n\tuseConfigOnly = true\n', 'utf8');
  fs.writeFileSync(systemCfg, '', 'utf8');
  execGit(['config', '--unset', 'user.email'], repo);
  execGit(['config', '--unset', 'user.name'], repo);
  return withEnv(
    {
      GIT_CONFIG_GLOBAL: globalCfg,
      GIT_CONFIG_SYSTEM: systemCfg,
      GIT_AUTHOR_NAME: undefined,
      GIT_AUTHOR_EMAIL: undefined,
      GIT_COMMITTER_NAME: undefined,
      GIT_COMMITTER_EMAIL: undefined,
      EMAIL: undefined,
    },
    async () => {
      const probe = execGit(['config', 'user.email'], repo);
      assert.equal(probe.ok, false, 'precondition: no git identity is configured');
      return fn();
    }
  );
}

function runOpts(repo: string, extra: Record<string, unknown> = {}) {
  return { cwd: repo, baseRef: 'main', agentCommand: 'node scripts/agent.mjs', concurrency: 1, maxRetries: 0, ...extra };
}

function logFiles(repo: string): string[] {
  const dir = path.join(repo, '.bastion', 'logs');
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
}

function commitPlanTitleChange(repo: string): void {
  const p = path.join(repo, '.bastion', 'plan.json');
  const plan = JSON.parse(fs.readFileSync(p, 'utf8')) as { nodes: Array<{ title: string }> };
  plan.nodes[plan.nodes.length - 1].title = 'Changed by a human';
  fs.writeFileSync(p, JSON.stringify(plan, null, 2) + '\n', 'utf8');
  git(['add', '.bastion/plan.json'], repo);
  git(['commit', '-m', 'human: edit plan on integration branch'], repo);
}

describe('v1.1 baselineDrift / driftMessage', () => {
  function driftRepo(): string {
    const repo = createTempGitRepo();
    writeRepoFile(repo, '.bastion/config.json', '{"a":1}\n');
    writeRepoFile(repo, '.bastion/plan.json', '{"nodes":[]}\n');
    writeRepoFile(repo, '.bastion/lock.json', '{"l":1}\n');
    writeRepoFile(repo, '.bastion/interfaces.md', 'iface\n');
    writeRepoFile(repo, 'src/x.txt', 'x\n');
    git(['add', '.'], repo);
    git(['commit', '-m', 'base'], repo);
    git(['checkout', '-b', 'feat'], repo);
    return repo;
  }

  it('BASELINE_FILES lists the six baseline files in the documented order', () => {
    assert.deepEqual([...BASELINE_FILES], [
      '.bastion/config.json',
      '.bastion/lock.json',
      '.bastion/plan.json',
      '.bastion/map.json',
      '.bastion/interfaces.md',
      '.bastion/acceptance.md',
    ]);
  });

  it('identical refs and changes to non-baseline files give []', () => {
    const repo = driftRepo();
    assert.deepEqual(baselineDrift(repo, 'main', 'feat'), []);
    writeRepoFile(repo, 'src/x.txt', 'changed\n');
    writeRepoFile(repo, 'src/new.txt', 'new\n');
    git(['add', '.'], repo);
    git(['commit', '-m', 'non-baseline change'], repo);
    assert.deepEqual(baselineDrift(repo, 'main', 'feat'), []);
  });

  it('reports a changed baseline file', () => {
    const repo = driftRepo();
    writeRepoFile(repo, '.bastion/plan.json', '{"nodes":[1]}\n');
    git(['commit', '-am', 'edit plan'], repo);
    assert.deepEqual(baselineDrift(repo, 'main', 'feat'), ['.bastion/plan.json']);
  });

  it('counts a file present on only one side (added or deleted) and returns BASELINE_FILES order, not alphabetical', () => {
    const repo = driftRepo();
    writeRepoFile(repo, '.bastion/acceptance.md', 'new acceptance\n'); // only on feat
    writeRepoFile(repo, '.bastion/config.json', '{"a":2}\n'); // changed
    fs.rmSync(path.join(repo, '.bastion', 'interfaces.md')); // only on main
    git(['add', '-A'], repo);
    git(['commit', '-m', 'many'], repo);
    assert.deepEqual(baselineDrift(repo, 'main', 'feat'), [
      '.bastion/config.json',
      '.bastion/interfaces.md',
      '.bastion/acceptance.md',
    ]);
  });

  it('compares commits, not the working tree', () => {
    const repo = driftRepo();
    writeRepoFile(repo, '.bastion/plan.json', '{"nodes":["uncommitted"]}\n');
    assert.deepEqual(baselineDrift(repo, 'main', 'feat'), [], 'uncommitted edit is invisible');
    git(['checkout', '--', '.bastion/plan.json'], repo);
    // the base moving ahead also counts as a difference (both directions are "differ")
    git(['checkout', 'main'], repo);
    writeRepoFile(repo, '.bastion/lock.json', '{"l":2}\n');
    git(['commit', '-am', 'base moved'], repo);
    assert.deepEqual(baselineDrift(repo, 'main', 'feat'), ['.bastion/lock.json']);
  });

  it('an unknown ref gives [] instead of throwing', () => {
    const repo = driftRepo();
    assert.deepEqual(baselineDrift(repo, 'main', 'no-such-branch'), []);
    assert.deepEqual(baselineDrift(repo, 'no-such-base', 'feat'), []);
  });

  it('driftMessage returns exactly the two documented lines', () => {
    assert.deepEqual(driftMessage(['.bastion/plan.json', '.bastion/config.json'], 'main', 'bastion/run-1'), [
      '[bastion] run: baseline file(s) differ between main and bastion/run-1: .bastion/plan.json, .bastion/config.json',
      '[bastion] run: this needs a human, not a retry: commit the change on main and merge main into bastion/run-1 (or revert it), then run: bastion run --resume',
    ]);
    assert.equal(driftMessage(['.bastion/map.json'], 'dev', 'x')[0], '[bastion] run: baseline file(s) differ between dev and x: .bastion/map.json');
  });
});

describe('v1.1 run: baseline drift stops for a human', () => {
  const STOP_B = [AGENT_PRELUDE, `if (id === 'db' && process.env.V11_FAIL_B) process.exit(1);`, `implementNode();`].join('\n') + '\n';

  it('resume after a human edited plan.json on the integration branch returns 2, calls no agent, changes nothing; reverting lets it resume', async () => {
    const repo = createSwarmRepo({ nodes: [{ id: 'da' }, { id: 'db' }], agentScript: STOP_B });
    const first = await withEnv({ V11_FAIL_B: '1' }, () => captureConsole(() => runSwarm(runOpts(repo))));
    assert.equal(first.result, 1, 'db fails, run stops midway');
    const before = readRunStateFile(repo);
    assert.deepEqual(before.completedNodes, ['da']);
    const branch = before.integrationBranch as string;
    assert.equal(git(['branch', '--show-current'], repo), branch);

    commitPlanTitleChange(repo);
    const logsBefore = logFiles(repo);
    const callsBefore = before.agentCalls;

    const stopped = await captureConsole(() => runSwarm(runOpts(repo, { resume: true })));
    assert.equal(stopped.result, EXIT_WAITING);
    assert.equal(EXIT_WAITING, 2);
    assert.ok(
      stopped.err.includes(`[bastion] run: baseline file(s) differ between main and ${branch}: .bastion/plan.json`),
      `first drift line missing in stderr:\n${stopped.err}`
    );
    assert.ok(
      stopped.err.includes(
        `[bastion] run: this needs a human, not a retry: commit the change on main and merge main into ${branch} (or revert it), then run: bastion run --resume`
      ),
      `second drift line missing in stderr:\n${stopped.err}`
    );
    assert.deepEqual(logFiles(repo), logsBefore, 'no agent ran: no new attempt log');
    const after = readRunStateFile(repo);
    assert.equal(after.agentCalls, callsBefore, 'no attempt is counted');
    assert.deepEqual(after.completedNodes, ['da']);

    // asking again changes nothing either
    const again = await captureConsole(() => runSwarm(runOpts(repo, { resume: true })));
    assert.equal(again.result, EXIT_WAITING);
    assert.equal(readRunStateFile(repo).agentCalls, callsBefore);

    git(['revert', '--no-edit', 'HEAD'], repo);
    const ok = await captureConsole(() => runSwarm(runOpts(repo, { resume: true })));
    assert.equal(ok.result, 0, ok.err);
    const done = readRunStateFile(repo);
    assert.deepEqual([...(done.completedNodes as string[])].sort(), ['da', 'db']);
    assert.equal(done.agentCalls, (callsBefore as number) + 1);
  });

  it('a fresh run started from a branch whose baseline files differ from the base is stopped before any agent call', async () => {
    const repo = createSwarmRepo({ nodes: [{ id: 'fa' }, { id: 'fb' }] });
    git(['checkout', '-b', 'feature'], repo);
    commitPlanTitleChange(repo);
    const r = await captureConsole(() => runSwarm(runOpts(repo)));
    assert.equal(r.result, EXIT_WAITING);
    assert.match(r.err, /\[bastion\] run: baseline file\(s\) differ between main and bastion\/run-[^:]*: \.bastion\/plan\.json/);
    assert.match(r.err, /bastion run --resume/);
    assert.deepEqual(logFiles(repo), [], 'no agent ran');
    const st = readRunState(repo);
    assert.ok(!st || ((st.agentCalls ?? 0) === 0 && st.completedNodes.length === 0));
  });
});

describe('v1.1 run: attempt logs are never overwritten', () => {
  const AGENT = [
    AGENT_PRELUDE,
    `console.log('ATTEMPT=' + process.env.BASTION_ATTEMPT);`,
    `if (process.env.V11_FAIL) { console.log('FIRST-RUN-MARK'); process.exit(1); }`,
    `console.log('SECOND-RUN-MARK');`,
    `implementNode();`,
  ].join('\n') + '\n';

  it('a node that failed once and is resumed keeps attempt-1.log intact and writes attempt-2.log', async () => {
    const repo = createSwarmRepo({ nodes: [{ id: 'lg' }], agentScript: AGENT });
    const first = await withEnv({ V11_FAIL: '1' }, () => captureConsole(() => runSwarm(runOpts(repo))));
    assert.equal(first.result, 1);
    const logDir = path.join(repo, '.bastion', 'logs');
    const firstContent = fs.readFileSync(path.join(logDir, 'lg-attempt-1.log'), 'utf8');
    assert.match(firstContent, /FIRST-RUN-MARK/);

    const second = await captureConsole(() => runSwarm(runOpts(repo, { resume: true })));
    assert.equal(second.result, 0, second.err);
    assert.deepEqual(logFiles(repo).filter((f) => f.startsWith('lg-attempt')), ['lg-attempt-1.log', 'lg-attempt-2.log']);
    assert.equal(fs.readFileSync(path.join(logDir, 'lg-attempt-1.log'), 'utf8'), firstContent, 'first log untouched');
    const secondContent = fs.readFileSync(path.join(logDir, 'lg-attempt-2.log'), 'utf8');
    assert.match(secondContent, /SECOND-RUN-MARK/);
    assert.doesNotMatch(secondContent, /FIRST-RUN-MARK/);
    // the in-session counter and BASTION_ATTEMPT restart at 1 while the file name moves on
    assert.match(secondContent, /ATTEMPT=1/);
    assert.match(second.out, /Attempt 1\/1/);
    assert.ok(second.out.includes('lg-attempt-2.log'), `console line must show the real file name:\n${second.out}`);
    assert.ok(!second.out.includes('lg-attempt-1.log'));
  });

  it('k is one more than the HIGHEST existing k for that node id (gaps, other nodes ignored)', async () => {
    const repo = createSwarmRepo({ nodes: [{ id: 'lg' }], agentScript: AGENT });
    const logDir = path.join(repo, '.bastion', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, 'lg-attempt-2.log'), 'old two', 'utf8');
    fs.writeFileSync(path.join(logDir, 'lg-attempt-7.log'), 'old seven', 'utf8');
    fs.writeFileSync(path.join(logDir, 'other-attempt-9.log'), 'not mine', 'utf8');
    const r = await captureConsole(() => runSwarm(runOpts(repo)));
    assert.equal(r.result, 0, r.err);
    assert.ok(fs.existsSync(path.join(logDir, 'lg-attempt-8.log')), logFiles(repo).join(','));
    assert.ok(!fs.existsSync(path.join(logDir, 'lg-attempt-10.log')));
    assert.equal(fs.readFileSync(path.join(logDir, 'lg-attempt-7.log'), 'utf8'), 'old seven');
    assert.equal(fs.readFileSync(path.join(logDir, 'lg-attempt-2.log'), 'utf8'), 'old two');
    assert.match(fs.readFileSync(path.join(logDir, 'lg-attempt-8.log'), 'utf8'), /ATTEMPT=1/);
  });

  it('retries inside one session continue the numbering (attempt 1 fails, attempt 2 passes)', async () => {
    const agent = [
      AGENT_PRELUDE,
      `console.log('ATTEMPT=' + process.env.BASTION_ATTEMPT);`,
      `if (process.env.BASTION_ATTEMPT === '1') process.exit(1);`,
      `implementNode();`,
    ].join('\n') + '\n';
    const repo = createSwarmRepo({ nodes: [{ id: 'lg' }], agentScript: agent });
    const logDir = path.join(repo, '.bastion', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, 'lg-attempt-3.log'), 'old three', 'utf8');
    const r = await captureConsole(() => runSwarm(runOpts(repo, { maxRetries: 1 })));
    assert.equal(r.result, 0, r.err);
    assert.match(fs.readFileSync(path.join(logDir, 'lg-attempt-4.log'), 'utf8'), /ATTEMPT=1/);
    assert.match(fs.readFileSync(path.join(logDir, 'lg-attempt-5.log'), 'utf8'), /ATTEMPT=2/);
    assert.equal(fs.readFileSync(path.join(logDir, 'lg-attempt-3.log'), 'utf8'), 'old three');
    assert.match(r.out, /Attempt 2\/2 .*lg-attempt-5\.log/);
  });
});

describe('v1.1 run: run-state extraDeps', () => {
  /** Resume a hand-made run-state on a fresh integration branch (what `bastion reopen --before` leaves behind). */
  function seedResume(repo: string, extraDeps: Record<string, string[]>, completed: string[] = []): RunState {
    const branch = 'bastion/run-seed';
    git(['checkout', '-b', branch], repo);
    const state: RunState = { integrationBranch: branch, baseRef: 'main', completedNodes: completed, agentCalls: 0, extraDeps };
    writeRepoFile(repo, '.bastion/run-state.json', JSON.stringify(state, null, 2) + '\n');
    return state;
  }

  // xa is slow; xb refuses to run unless xa's work is already merged (its worktree is cut from HEAD when it starts).
  const AGENT = [
    AGENT_PRELUDE,
    `if (id === 'xa') await new Promise((r) => setTimeout(r, 900));`,
    `if (id === 'xb') {`,
    `  const saw = fs.readFileSync('src/xa.mjs', 'utf8').includes('= 1');`,
    `  console.log('SAW_A=' + saw);`,
    `  if (!saw) process.exit(1);`,
    `}`,
    `implementNode();`,
  ].join('\n') + '\n';

  it('a node with extraDeps starts only after its extra dependency is merged (concurrency 2), unknown ids are ignored, extraDeps survives', async () => {
    const repo = createSwarmRepo({ nodes: [{ id: 'xa' }, { id: 'xb' }], agentScript: AGENT });
    const extraDeps = { xb: ['xa', 'ghost'], phantom: ['xa'] };
    seedResume(repo, extraDeps);
    const r = await captureConsole(() => runSwarm(runOpts(repo, { resume: true, concurrency: 2 })));
    assert.equal(r.result, 0, `unknown ids must not block scheduling:\n${r.err}`);
    const mergeA = r.out.indexOf('[bastion] Merging bastion/xa');
    const attemptB = r.out.indexOf('[xb] Attempt 1/1');
    assert.ok(mergeA >= 0 && attemptB >= 0, r.out);
    assert.ok(mergeA < attemptB, 'xb must not start before xa is merged');
    assert.match(fs.readFileSync(path.join(repo, '.bastion', 'logs', 'xb-attempt-1.log'), 'utf8'), /SAW_A=true/);
    const st = readRunStateFile(repo);
    assert.deepEqual([...(st.completedNodes as string[])].sort(), ['xa', 'xb']);
    assert.deepEqual(st.extraDeps, extraDeps, 'extraDeps is carried over unchanged');
  });

  it('without extraDeps the same two nodes run in parallel (so the ordering above is really caused by extraDeps)', async () => {
    const repo = createSwarmRepo({ nodes: [{ id: 'xa' }, { id: 'xb' }], agentScript: AGENT });
    seedResume(repo, {});
    const r = await captureConsole(() => runSwarm(runOpts(repo, { resume: true, concurrency: 2 })));
    assert.equal(r.result, 1, 'xb starts next to xa and cannot see its work');
    assert.deepEqual(readRunStateFile(repo).extraDeps, {});
  });

  it('extraDeps is kept in run-state even when the run stops early', async () => {
    const failing = [AGENT_PRELUDE, `if (id === 'xa') process.exit(1);`, `implementNode();`].join('\n') + '\n';
    const repo = createSwarmRepo({ nodes: [{ id: 'xa' }, { id: 'xb' }], agentScript: failing });
    seedResume(repo, { xb: ['xa'] });
    const r = await captureConsole(() => runSwarm(runOpts(repo, { resume: true, concurrency: 2 })));
    assert.equal(r.result, 1);
    const st = readRunStateFile(repo);
    assert.deepEqual(st.extraDeps, { xb: ['xa'] });
    assert.deepEqual(st.completedNodes, [], 'xb never started because xa did not complete');
    assert.equal(st.agentCalls, 1);
  });
});

describe('v1.1 run: commits and merges without a git identity', () => {
  it('a whole runSwarm with two nodes completes with no git identity (node commit and merge commit)', async () => {
    const repo = createSwarmRepo({ nodes: [{ id: 'na' }, { id: 'nb' }] });
    const r = await withoutGitIdentity(repo, () => captureConsole(() => runSwarm(runOpts(repo, { concurrency: 2 }))));
    assert.equal(r.result, 0, `${r.err}\n${r.out}`);
    const st = readRunStateFile(repo);
    assert.deepEqual([...(st.completedNodes as string[])].sort(), ['na', 'nb']);
    const authors = git(['log', '--format=%an|%s', `main..${st.integrationBranch as string}`], repo).split('\n');
    assert.ok(authors.some((l) => l.startsWith('bastion|bastion(na)')), authors.join('\n'));
    assert.ok(authors.some((l) => l.startsWith('bastion|feat(nb)')), authors.join('\n'));
  });

  it('with a configured identity the user\'s identity is used for the node commit and the merge commit', async () => {
    const repo = createSwarmRepo({ nodes: [{ id: 'na' }, { id: 'nb' }] });
    const r = await captureConsole(() => runSwarm(runOpts(repo, { concurrency: 2 })));
    assert.equal(r.result, 0, r.err);
    const branch = readRunStateFile(repo).integrationBranch as string;
    const lines = git(['log', '--format=%an|%s', `main..${branch}`], repo).split('\n');
    assert.equal(lines.length, 4, lines.join('\n'));
    for (const l of lines) assert.ok(l.startsWith('Bastion Test|'), `expected the user's identity, got: ${l}`);
  });

  it('mergeNodeBranch makes its --no-ff merge commit without a git identity', async () => {
    const repo = createTempGitRepo();
    writeRepoFile(repo, 'a.txt', 'a\n');
    git(['add', '.'], repo);
    git(['commit', '-m', 'init'], repo);
    const handle = createNodeWorktree(repo, resolveRef('HEAD', repo)!, 'mn');
    writeRepoFile(handle.dir, 'mn.txt', 'node\n');
    git(['add', '.'], handle.dir);
    git(['commit', '-m', 'node work'], handle.dir);
    await withoutGitIdentity(repo, async () => {
      mergeNodeBranch(repo, handle, 'Merge title');
    });
    assert.equal(git(['log', '-1', '--format=%s'], repo), 'bastion(mn): Merge title');
    assert.equal(git(['log', '-1', '--format=%an'], repo), 'bastion');
    assert.equal(git(['rev-list', '--parents', '-n', '1', 'HEAD'], repo).split(' ').length, 3, 'a real two-parent merge commit');
    assert.ok(fs.existsSync(path.join(repo, 'mn.txt')));
  });

  it('mergeNodeBranch keeps the configured identity when there is one', () => {
    const repo = createTempGitRepo();
    writeRepoFile(repo, 'a.txt', 'a\n');
    git(['add', '.'], repo);
    git(['commit', '-m', 'init'], repo);
    const handle = createNodeWorktree(repo, resolveRef('HEAD', repo)!, 'mk');
    writeRepoFile(handle.dir, 'mk.txt', 'node\n');
    git(['add', '.'], handle.dir);
    git(['commit', '-m', 'node work'], handle.dir);
    mergeNodeBranch(repo, handle, 'T');
    assert.equal(git(['log', '-1', '--format=%an'], repo), 'Bastion Test');
  });
});
