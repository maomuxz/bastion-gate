// v1.1 hardening (round 5), run side: single-mode feedback, killProcessTree, runTestCommandAsync timeout,
// and agent timeouts that must take the whole process tree with them.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, it } from 'node:test';
import { runSwarm } from '../src/commands/run.js';
import { killProcessTree, runTestCommandAsync } from '../src/runner.js';
import { AGENT_PRELUDE, captureConsole, cleanupTempRepos, createSwarmRepo, readRunStateFile, writeRepoFile } from './v04-helpers.js';

const extraTemp: string[] = [];
const leakedPids = new Set<number>();
afterEach(() => {
  for (const pid of leakedPids) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  leakedPids.clear();
  cleanupTempRepos();
  while (extraTemp.length > 0) fs.rmSync(extraTemp.pop()!, { recursive: true, force: true });
});

function tempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bastion-v11-hard-'));
  extraTemp.push(d);
  return d;
}

async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    process.env[k] = vars[k];
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

/** Resolve with the promise, or with a marker after ms so a hung implementation fails an assertion instead of hanging the file. */
async function orHang<T>(p: Promise<T>, ms: number): Promise<T | 'HUNG'> {
  let t: NodeJS.Timeout | undefined;
  const timer = new Promise<'HUNG'>((r) => { t = setTimeout(() => r('HUNG'), ms); });
  try { return await Promise.race([p, timer]); } finally { clearTimeout(t); }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitForPidFile(file: string, ms = 10_000): Promise<number> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fs.existsSync(file)) {
      const n = Number(fs.readFileSync(file, 'utf8').trim());
      if (Number.isInteger(n) && n > 0) return n;
    }
    await sleep(50);
  }
  throw new Error(`pid file ${file} never appeared`);
}

async function waitUntilDead(pid: number, ms = 5_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!isAlive(pid)) return true;
    await sleep(100);
  }
  return !isAlive(pid);
}

/** Script of a never-ending node process that records its pid. */
function writeForever(dir: string, name: string, pidFile: string): string {
  const f = path.join(dir, name);
  fs.writeFileSync(
    f,
    `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`,
    'utf8'
  );
  return f;
}

/** Script of a node process that starts the forever child (stdio inherited when asked) and then lives on itself. */
function writeParent(dir: string, childScript: string, inherit: boolean): string {
  const f = path.join(dir, 'parent.js');
  fs.writeFileSync(
    f,
    [
      `const { spawn } = require('child_process');`,
      `spawn(process.execPath, [${JSON.stringify(childScript)}], { stdio: ${inherit ? `'inherit'` : `'ignore'`} });`,
      `setInterval(() => {}, 1000);`,
    ].join('\n') + '\n',
    'utf8'
  );
  return f;
}

describe('v1.1 killProcessTree', () => {
  it('kills the process AND the never-ending child it started', async () => {
    const dir = tempDir();
    const childPidFile = path.join(dir, 'child.pid');
    const child = writeForever(dir, 'child.js', childPidFile);
    const parentScript = writeParent(dir, child, false);
    const parent = spawn(process.execPath, [parentScript], { stdio: 'ignore', detached: process.platform !== 'win32' });
    assert.ok(parent.pid, 'parent started');
    leakedPids.add(parent.pid!);
    const childPid = await waitForPidFile(childPidFile);
    leakedPids.add(childPid);
    assert.ok(isAlive(childPid), 'precondition: child is alive');

    killProcessTree(parent.pid!);

    assert.equal(await waitUntilDead(childPid, 5_000), true, 'child must be gone within 5 s');
    assert.equal(isAlive(childPid), false, 'child still alive after killProcessTree');
    assert.equal(await waitUntilDead(parent.pid!, 5_000), true, 'parent must be gone too');
  });

  it('does not throw for a pid that does not exist', () => {
    const dead = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
    const pid = dead.pid!;
    return new Promise<void>((resolve) => {
      dead.on('close', () => {
        assert.doesNotThrow(() => killProcessTree(pid));
        assert.doesNotThrow(() => killProcessTree(2_000_000_000));
        resolve();
      });
    });
  });
});

describe('v1.1 runTestCommandAsync timeout', () => {
  it('kills a never-ending grandchild that holds stdout, and resolves with 124 well within 15 s', async () => {
    const dir = tempDir();
    const pidFile = path.join(dir, 'gc.pid');
    const child = writeForever(dir, 'gc.js', pidFile);
    const parentScript = writeParent(dir, child, true);
    const started = Date.now();
    const resOrHung = await orHang(runTestCommandAsync(`node "${parentScript}"`, dir, 1500), 15_000);
    const elapsed = Date.now() - started;
    const gcPid = await waitForPidFile(pidFile);
    leakedPids.add(gcPid);
    assert.notEqual(resOrHung, 'HUNG', `runTestCommandAsync did not resolve within 15 s (${elapsed}ms)`);
    const res = resOrHung as Exclude<typeof resOrHung, 'HUNG'>;

    assert.equal(res.exitCode, 124);
    assert.match(res.stderr, /timed out after 1500ms/);
    assert.ok(elapsed < 15_000, `must resolve soon after the timeout, took ${elapsed}ms`);
    assert.equal(await waitUntilDead(gcPid, 5_000), true, 'grandchild survived the timeout');
  });

  it('a command that finishes in time is unchanged', async () => {
    const dir = tempDir();
    const res = await runTestCommandAsync(`node -e "console.log('fine')"`, dir, 20_000);
    assert.equal(res.exitCode, 0);
    assert.match(res.stdout, /fine/);
    assert.doesNotMatch(res.stderr, /timed out/);
  });
});

describe('v1.1 run (g): single-mode feedback', () => {
  const SENTENCE_B = 'Distinctive reopen reason for the second node: handle the unicorn case.';
  const SINGLE_AGENT = [
    AGENT_PRELUDE,
    `fs.writeFileSync(process.env.V11_PROMPT_OUT, prompt);`,
    `for (const n of ['fa', 'fb']) fs.writeFileSync('src/' + n + '.mjs', 'export const ' + n + ' = 1;\\n');`,
  ].join('\n') + '\n';

  const opts = (repo: string, extra: Record<string, unknown> = {}) => ({
    cwd: repo, baseRef: 'main', agentCommand: 'node scripts/agent.mjs', concurrency: 1, maxRetries: 0, ...extra,
  });

  it('the prompt carries `### <id>` + content for each node that has feedback, nothing for the others; files are gone after a pass', async () => {
    const out = path.join(tempDir(), 'prompt.txt');
    const repo = createSwarmRepo({ nodes: [{ id: 'fa' }, { id: 'fb' }], agentScript: SINGLE_AGENT });
    writeRepoFile(repo, '.bastion/feedback/fb.md', `${SENTENCE_B}\n`);
    const r = await withEnv({ V11_PROMPT_OUT: out }, () => captureConsole(() => runSwarm(opts(repo, { mode: 'single' }))));
    assert.equal(r.result, 0, `${r.err}\n${r.out}`);
    const prompt = fs.readFileSync(out, 'utf8');
    assert.ok(prompt.includes('### fb'), 'heading for the node with feedback');
    assert.ok(prompt.includes(SENTENCE_B), 'feedback sentence reaches the single agent');
    assert.ok(prompt.indexOf('### fb') < prompt.indexOf(SENTENCE_B), 'heading comes before its content');
    assert.ok(!prompt.includes('### fa'), 'a node without a feedback file gets no heading');
    assert.ok(!fs.existsSync(path.join(repo, '.bastion', 'feedback', 'fb.md')), 'feedback file deleted after the gate passed');
  });

  it('plan order, all-nodes.md still included, empty/whitespace feedback files get no heading', async () => {
    const out = path.join(tempDir(), 'prompt.txt');
    const repo = createSwarmRepo({ nodes: [{ id: 'fa' }, { id: 'fb' }], agentScript: SINGLE_AGENT });
    // written in reverse order on purpose; the order in the prompt must be plan order
    writeRepoFile(repo, '.bastion/feedback/fb.md', 'FB-CONTENT-LINE\n');
    writeRepoFile(repo, '.bastion/feedback/fa.md', 'FA-CONTENT-LINE\n');
    writeRepoFile(repo, '.bastion/feedback/all-nodes.md', 'ALL-NODES-CONTENT-LINE\n');
    const r = await withEnv({ V11_PROMPT_OUT: out }, () => captureConsole(() => runSwarm(opts(repo, { mode: 'single' }))));
    assert.equal(r.result, 0, `${r.err}\n${r.out}`);
    const prompt = fs.readFileSync(out, 'utf8');
    const ia = prompt.indexOf('### fa');
    const ib = prompt.indexOf('### fb');
    assert.ok(ia >= 0 && ib >= 0 && ia < ib, 'both headings, plan order');
    assert.ok(prompt.indexOf('FA-CONTENT-LINE') > ia && prompt.indexOf('FA-CONTENT-LINE') < ib, 'fa content sits under the fa heading');
    assert.ok(prompt.indexOf('FB-CONTENT-LINE') > ib);
    assert.ok(prompt.includes('ALL-NODES-CONTENT-LINE'), 'all-nodes.md content still included');
    for (const f of ['fa.md', 'fb.md', 'all-nodes.md']) {
      assert.ok(!fs.existsSync(path.join(repo, '.bastion', 'feedback', f)), `${f} must be deleted after a pass`);
    }

    // whitespace-only feedback counts as empty
    const out2 = path.join(tempDir(), 'prompt2.txt');
    const repo2 = createSwarmRepo({ nodes: [{ id: 'fa' }, { id: 'fb' }], agentScript: SINGLE_AGENT });
    writeRepoFile(repo2, '.bastion/feedback/fa.md', '  \n\n');
    writeRepoFile(repo2, '.bastion/feedback/fb.md', 'ONLY-B\n');
    const r2 = await withEnv({ V11_PROMPT_OUT: out2 }, () => captureConsole(() => runSwarm(opts(repo2, { mode: 'single' }))));
    assert.equal(r2.result, 0, `${r2.err}\n${r2.out}`);
    const p2 = fs.readFileSync(out2, 'utf8');
    assert.ok(p2.includes('### fb') && p2.includes('ONLY-B'));
    assert.ok(!p2.includes('### fa'), 'empty feedback file gets no heading');
  });

  it('swarm mode: a node prompt contains only its own feedback', async () => {
    const outDir = tempDir();
    const agent = [
      AGENT_PRELUDE,
      `fs.writeFileSync(process.env.V11_PROMPT_DIR + '/' + id + '.txt', prompt);`,
      `implementNode();`,
    ].join('\n') + '\n';
    const repo = createSwarmRepo({ nodes: [{ id: 'fa' }, { id: 'fb' }], agentScript: agent });
    writeRepoFile(repo, '.bastion/feedback/fb.md', `${SENTENCE_B}\n`);
    const r = await withEnv({ V11_PROMPT_DIR: outDir }, () => captureConsole(() => runSwarm(opts(repo, { mode: 'swarm', concurrency: 2 }))));
    assert.equal(r.result, 0, `${r.err}\n${r.out}`);
    const pa = fs.readFileSync(path.join(outDir, 'fa.txt'), 'utf8');
    const pb = fs.readFileSync(path.join(outDir, 'fb.txt'), 'utf8');
    assert.ok(pb.includes(SENTENCE_B));
    assert.ok(!pa.includes(SENTENCE_B), "fa must not see fb's feedback");
    assert.ok(!pa.includes('### fb') && !pb.includes('### fb'));
    assert.ok(!fs.existsSync(path.join(repo, '.bastion', 'feedback', 'fb.md')));
  });
});

describe('v1.1 run (h): agent timeout takes the process tree down', () => {
  it('a hung agent with a surviving grandchild: runSwarm returns, node not completed, grandchild gone', { timeout: 120_000 }, async () => {
    const dir = tempDir();
    const pidFile = path.join(dir, 'agent-gc.pid');
    const forever = writeForever(dir, 'agent-gc.js', pidFile);
    const agent = [
      AGENT_PRELUDE,
      `import { spawn } from 'node:child_process';`,
      `fs.writeFileSync(${JSON.stringify(pidFile + '.agent')}, String(process.pid));`,
      `spawn(process.execPath, [${JSON.stringify(forever)}], { stdio: 'inherit' });`,
      `await new Promise(() => {});`,
    ].join('\n') + '\n';
    const repo = createSwarmRepo({ nodes: [{ id: 'ha' }], agentScript: agent });
    const started = Date.now();
    const rOrHung = await orHang(
      captureConsole(() =>
        runSwarm({ cwd: repo, baseRef: 'main', agentCommand: 'node scripts/agent.mjs', concurrency: 1, maxRetries: 0, timeoutMinutes: 0.03 })
      ),
      60_000
    );
    const elapsed = Date.now() - started;
    const gcPid = await waitForPidFile(pidFile);
    leakedPids.add(gcPid);
    leakedPids.add(await waitForPidFile(pidFile + '.agent'));
    assert.notEqual(rOrHung, 'HUNG', 'runSwarm did not return within 60 s');
    const r = rOrHung as Exclude<typeof rOrHung, 'HUNG'>;

    assert.notEqual(r.result, 0, 'a timed-out node fails the run');
    assert.ok(elapsed < 60_000, `runSwarm must return soon after the timeout, took ${elapsed}ms`);
    const st = readRunStateFile(repo);
    assert.deepEqual(st.completedNodes, [], 'the node is not completed');
    assert.equal(await waitUntilDead(gcPid, 5_000), true, 'the agent grandchild must be killed with the tree');
  });
});
