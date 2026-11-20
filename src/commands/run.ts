import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkBudget, resolveBudgetLimits } from '../budget.js';
import {
  PlanNode,
  readConfigFromDisk,
  readPlanFromDisk,
} from '../config.js';
import { baselineDrift, driftMessage } from '../baseline.js';
import { execGit, getDirtyFiles, getRepoRoot, gitIdentityArgs, resolveRef } from '../git.js';
import { buildExecutionWaves } from '../orchestrator/dag.js';
import {
  createNodeWorktree,
  mergeNodeBranch,
  removeNodeWorktree,
  WorktreeHandle,
} from '../orchestrator/worktree.js';
import { answersForNode, hasOpenQuestion, openQuestions } from '../inbox.js';
import { appendDecisions } from '../ledger.js';
import { collectOutbox } from '../outbox.js';
import { agentProtocol } from '../protocol.js';
import { resolveAgentCommand } from '../roles.js';
import { mergeNodesForSingle, resolveRunMode, RunMode, SINGLE_NODE_ID } from '../single.js';
import { createSlotPool } from '../slots.js';
import { blockingDirtyFiles } from '../dirty.js';
import { killProcessTree, runTestCommandAsync } from '../runner.js';
import { readRunState, RunState, writeRunState } from '../state.js';
import { runGateAsync } from './gate.js';

/** v0.4 exit codes: 1 = failure, 2 = waiting for a human answer, 3 = budget exhausted. */
export const EXIT_FAILED = 1;
export const EXIT_WAITING = 2;
export const EXIT_BUDGET = 3;

/** Absolute path of the CLI entry, exposed to agents as BASTION_CLI so they can run `node "$BASTION_CLI" decide ...`. */
const BASTION_CLI_PATH = fileURLToPath(new URL('../cli.js', import.meta.url));

export interface RunOptions {
  cwd: string;
  baseRef?: string;
  agentCommand?: string;
  setupCommand?: string;
  concurrency?: number;
  maxRetries?: number;
  verifyRuns?: number;
  timeoutMinutes?: number;
  resume?: boolean;
  /** v0.4: override config.budget.maxAgentCalls (compared against calls already used). */
  maxCalls?: number;
  /** v0.4: override config.budget.maxMinutes (compared against minutes already used). */
  maxMinutes?: number;
  /** v1.0: force 'single' (one agent session for the whole plan) or 'swarm'. */
  mode?: RunMode;
  /** v1.1 switch: false = construction AIs may not queue questions (see runSwarm (e)). Default true. */
  questions?: boolean;
  /** v1.1 switch: false = budget limits are not enforced in this run (see runSwarm (f)). Default true. */
  budget?: boolean;
}

/** v1.0: QA feedback for a reopened node (written by `bastion qa`, consumed on the next attempt). */
const QA_FEEDBACK_DIR = path.join('.bastion', 'feedback');
function readQaFeedback(repoRoot: string, nodeId: string): string {
  const p = path.join(repoRoot, QA_FEEDBACK_DIR, `${nodeId}.md`);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim() : '';
}

/** v1.1: next free `<id>-attempt-<k>.log` name (k = highest existing + 1). */
function nextAttemptLogName(logsDir: string, nodeId: string): string {
  let max = 0;
  const prefix = `${nodeId}-attempt-`;
  if (fs.existsSync(logsDir)) {
    for (const f of fs.readdirSync(logsDir)) {
      const m = f.startsWith(prefix) ? /^(\d+)\.log$/.exec(f.slice(prefix.length)) : null;
      if (m) max = Math.max(max, Number(m[1]));
    }
  }
  return `${prefix}${max + 1}.log`;
}

/** Why a node attempt loop stopped without passing. */
type NodeStop = 'failed' | 'blocked' | 'budget';

interface NodeOutcome {
  ok: boolean;
  node: PlanNode;
  handle: WorktreeHandle;
  stop?: NodeStop;
}

interface AgentExecResult {
  exitCode: number;
  output: string;
  timedOut: boolean;
}

const BLOCKED_COMMIT_PATTERN = /(?:^|\/)(?:\.env(?:\..+)?|\.DS_Store|Thumbs\.db)$|^\.bastion\//;

function stageSafeWorktreeFiles(worktreeDir: string, nodeId: string): boolean {
  const dirty = getDirtyFiles(worktreeDir);
  if (dirty.length === 0) return true;

  const allowed: string[] = [];
  const skipped: string[] = [];
  for (const rel of dirty) {
    if (BLOCKED_COMMIT_PATTERN.test(rel)) {
      skipped.push(rel);
    } else {
      allowed.push(rel);
    }
  }

  if (skipped.length > 0) {
    console.warn(`[${nodeId}] Skipping untracked/sensitive files: ${skipped.join(', ')}`);
  }
  if (allowed.length === 0) return true;

  console.log(`[${nodeId}] Staging ${allowed.length} file(s): ${allowed.join(', ')}`);
  const addRes = execGit(['add', '--', ...allowed], worktreeDir);
  if (!addRes.ok) {
    console.error(`[${nodeId}] git add failed: ${addRes.stderr}`);
    return false;
  }

  const commitRes = execGit(
    [...gitIdentityArgs(worktreeDir), 'commit', '-m', `feat(${nodeId}): apply verified changes`],
    worktreeDir
  );
  if (!commitRes.ok) {
    console.error(`[${nodeId}] git commit failed: ${commitRes.stderr}`);
    return false;
  }
  return true;
}

function runAgentAsync(
  commandTemplate: string,
  node: PlanNode,
  worktreeDir: string,
  attempt: number,
  feedback: string,
  logFile: string,
  promptFile: string,
  timeoutMs: number,
  repoRoot: string,
  questionsOff = false
): Promise<AgentExecResult> {
  return new Promise((resolve) => {
    const basePrompt = agentProtocol(node.id, BASTION_CLI_PATH) + node.prompt;
    const fullPrompt = feedback
      ? `${basePrompt}\n\n[Bastion Gate Feedback - Fix Required]\n${feedback}`
      : basePrompt;

    fs.mkdirSync(path.dirname(promptFile), { recursive: true });
    fs.writeFileSync(promptFile, fullPrompt, 'utf8');
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const logStream = fs.createWriteStream(logFile, { flags: 'w' });

    const escapedSingleLine = fullPrompt.replace(/[\r\n]+/g, ' ').replace(/"/g, '\\"');
    const cmd = commandTemplate
      .replace(/\{promptFile\}/g, promptFile)
      .replace(/\{prompt\}/g, escapedSingleLine)
      .replace(/\{nodeId\}/g, node.id)
      .replace(/\{worktree\}/g, worktreeDir);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      BASTION_NODE_ID: node.id,
      BASTION_NODE_TITLE: node.title,
      BASTION_PROMPT: fullPrompt,
      BASTION_PROMPT_FILE: promptFile,
      BASTION_WORKTREE: worktreeDir,
      BASTION_ATTEMPT: String(attempt),
      BASTION_FEEDBACK: feedback,
      BASTION_CLI: BASTION_CLI_PATH,
      BASTION_HOME: repoRoot,
    };
    delete env.NODE_TEST_CONTEXT;
    if (questionsOff) env.BASTION_QUESTIONS = 'off';
    else delete env.BASTION_QUESTIONS;

    const child = spawn(cmd, {
      cwd: worktreeDir,
      env,
      shell: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    let lineBuf = '';
    let timedOut = false;
    let settled = false;
    let grace: NodeJS.Timeout | null = null;

    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (grace) clearTimeout(grace);
      if (lineBuf.trim()) console.log(`  [${node.id}] ${lineBuf}`);
      logStream.end();
      resolve({ exitCode: timedOut ? 124 : (code ?? 1), output, timedOut });
    };

    const timer = timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          logStream.write(`\n[bastion] Agent timed out after ${timeoutMs}ms.\n`);
          if (child.pid !== undefined) killProcessTree(child.pid);
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
          grace = setTimeout(() => {
            child.stdout?.destroy();
            child.stderr?.destroy();
            finish(124);
          }, 2000);
        }, timeoutMs)
      : null;

    const onChunk = (chunk: Buffer) => {
      const text = String(chunk);
      output += text;
      logStream.write(text);
      lineBuf += text;
      const lines = lineBuf.split(/\r?\n/);
      lineBuf = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) console.log(`  [${node.id}] ${line}`);
      }
    };

    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);
    child.on('error', () => finish(1));
    child.on('close', (code) => finish(code));
  });
}

/**
 * v1.1 additions to runSwarm:
 * (a) Baseline drift stops for a human. Once the integration branch is known (a fresh one or the resumed one) and before
 *     any agent call of this session: drift = baselineDrift(repoRoot, baseRef, integrationBranch) (src/baseline.ts).
 *     Non-empty -> print driftMessage(...) to stderr and return EXIT_WAITING (2). No agent is called, no attempt is
 *     counted (agentCalls unchanged) and completedNodes is unchanged.
 * (b) Attempt logs are never overwritten: the log of an attempt is `.bastion/logs/<id>-attempt-<k>.log` where k is one
 *     more than the highest k already present for that node id in the logs directory (1 when none). The console line
 *     shows that real file name. The "Attempt i/N" counter and BASTION_ATTEMPT keep counting from 1 in each session.
 * (c) run-state extraDeps (written by `bastion reopen --before`): a node is ready only when its plan dependsOn AND its
 *     extraDeps ids are all complete; ids that are not plan nodes are ignored. extraDeps is carried over unchanged
 *     whenever run-state is written.
 * (d) The commit of verified changes passes gitIdentityArgs(worktreeDir) instead of always forcing the bastion identity.
 * (e) opts.questions === false: every agent process gets env BASTION_QUESTIONS=off (otherwise the variable is not set
 *     by bastion; an inherited value is removed). `bastion ask` refuses to queue a question when it sees that value, so
 *     no node ends up blocked waiting for an answer.
 * (f) opts.budget === false: neither config.budget nor --max-calls / --max-minutes stop the run (it never returns
 *     EXIT_BUDGET and never records budgetHit); agentCalls and accumulatedMinutes are still counted.
 */
/*
 * v1.1 hardening (round 5). These rules replace the older wording above wherever they differ.
 * (g) Single mode feedback. In single mode the one agent session builds every plan node, so its prompt must carry the
 *     feedback written for ANY of them: the QA / reopen feedback section contains, for every plan node (plan order)
 *     that has a non-empty .bastion/feedback/<id>.md, a line `### <id>` followed by that file's content, plus the
 *     content of .bastion/feedback/all-nodes.md when it exists. (Before, only all-nodes.md was read, so
 *     `bastion reopen <node> --reason ...` and QA findings never reached the agent.) The files are deleted after the
 *     gate passed, as before. Swarm mode is unchanged (each node reads its own file).
 * (h) Agent timeout. When an agent call times out, the whole process tree is terminated with killProcessTree from
 *     ../runner.js (POSIX: spawn detached), and the call resolves within about 5 seconds after the timeout even if a
 *     surviving process keeps the pipes open. The attempt is reported as timed out exactly as before.
 */
export async function runSwarm(opts: RunOptions): Promise<number> {
  const repoRoot = getRepoRoot(opts.cwd);
  if (!repoRoot) {
    console.error('[bastion] Error: not inside a git repository.');
    return 1;
  }

  const config = readConfigFromDisk(repoRoot);
  const plan = readPlanFromDisk(repoRoot);
  const waves = buildExecutionWaves(plan.nodes);
  const mode = resolveRunMode(config, opts.mode, plan.nodes.length);
  const runNodes: PlanNode[] = mode === 'single' ? [mergeNodesForSingle(plan.nodes, config.testCommand)] : plan.nodes;
  const gateSlots = createSlotPool(config.compileSlots);

  const blockedTier3 = plan.nodes.filter((n) => n.tier === 3 && !n.approved);
  if (blockedTier3.length > 0) {
    console.error('[bastion] RUN BLOCKED: tier-3 node(s) require human approval ("approved": true):');
    for (const n of blockedTier3) console.error(`  - ${n.id}: ${n.title}`);
    return 1;
  }

  const agentCmd = resolveAgentCommand(config, 'worker', opts.agentCommand);
  if (!agentCmd) {
    console.error('[bastion] Error: no agentCommand configured. Pass --agent "<cmd>" or set "agentCommand" in .bastion/config.json.');
    return 1;
  }

  const baseRef = opts.baseRef ?? config.baseBranch;
  if (!resolveRef(baseRef, repoRoot)) {
    console.error(`[bastion] Error: cannot resolve baseline ref "${baseRef}".`);
    return 1;
  }

  const dirty = blockingDirtyFiles(repoRoot, [...config.lockedGlobs, ...config.extraLockedPaths]);
  if (dirty.length > 0) {
    console.error(`[bastion] Error: working tree is not clean (${dirty.slice(0, 5).join(', ')}). Commit or stash changes before \`bastion run\`.`);
    return 1;
  }

  const setupCmd = opts.setupCommand ?? config.setupCommand;
  const concurrency = opts.concurrency ?? config.concurrency ?? 2;
  const maxRetries = opts.maxRetries ?? config.maxRetries ?? 2;
  const verifyRuns = opts.verifyRuns ?? config.verifyRuns ?? 1;
  const timeoutMs = (opts.timeoutMinutes ?? config.timeoutMinutes ?? 20) * 60_000;

  const limits = resolveBudgetLimits(config, {
    ...(opts.maxCalls !== undefined ? { maxAgentCalls: opts.maxCalls } : {}),
    ...(opts.maxMinutes !== undefined ? { maxMinutes: opts.maxMinutes } : {}),
  });

  let integrationBranch: string;
  const completedSet = new Set<string>();
  const blockedSet = new Set<string>();
  const runningSet = new Set<string>();
  let extraDeps: Record<string, string[]> | undefined;
  let agentCalls = 0;
  let priorMinutes = 0;
  let budgetHit: 'calls' | 'minutes' | null = null;
  const sessionStart = Date.now();
  const minutesUsed = () => priorMinutes + (Date.now() - sessionStart) / 60_000;

  if (opts.resume) {
    const prev = readRunState(repoRoot);
    if (!prev) {
      console.error('[bastion] Error: no .bastion/run-state.json found to resume from.');
      return 1;
    }
    integrationBranch = prev.integrationBranch;
    for (const id of prev.completedNodes) completedSet.add(id);
    for (const id of prev.blockedNodes ?? []) blockedSet.add(id);
    agentCalls = prev.agentCalls ?? 0;
    priorMinutes = prev.accumulatedMinutes ?? 0;
    extraDeps = prev.extraDeps;
    const checkoutRes = execGit(['checkout', integrationBranch], repoRoot);
    if (!checkoutRes.ok) {
      console.error(`[bastion] Error checking out ${integrationBranch}: ${checkoutRes.stderr}`);
      return 1;
    }
    const resumeDrift = baselineDrift(repoRoot, baseRef, integrationBranch);
    if (resumeDrift.length > 0) {
      for (const line of driftMessage(resumeDrift, baseRef, integrationBranch)) console.error(line);
      return EXIT_WAITING;
    }
    console.log(`[bastion] Resuming "${integrationBranch}" (${completedSet.size} node(s) already completed).`);
  } else {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    integrationBranch = `bastion/run-${stamp}`;
    const checkoutRes = execGit(['checkout', '-b', integrationBranch], repoRoot);
    if (!checkoutRes.ok) {
      console.error(`[bastion] Error creating integration branch ${integrationBranch}: ${checkoutRes.stderr}`);
      return 1;
    }
    const freshDrift = baselineDrift(repoRoot, baseRef, integrationBranch);
    if (freshDrift.length > 0) {
      for (const line of driftMessage(freshDrift, baseRef, integrationBranch)) console.error(line);
      return EXIT_WAITING;
    }
  }

  const saveState = () => {
    const state: RunState = {
      integrationBranch,
      baseRef,
      completedNodes: [...completedSet],
      agentCalls,
      accumulatedMinutes: Math.round(minutesUsed() * 1000) / 1000,
      blockedNodes: [...blockedSet],
      runningNodes: [...runningSet],
      ...(extraDeps ? { extraDeps } : {}),
      ...(budgetHit ? { budgetHit } : {}),
    };
    writeRunState(repoRoot, state);
  };
  saveState();

  const logsDir = path.join(repoRoot, '.bastion', 'logs');
  const pidFile = path.join(repoRoot, '.bastion', 'run.pid');
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, String(process.pid), 'utf8');

  try {
  console.log(`[bastion] Integration branch: ${integrationBranch}`);
  console.log(`[bastion] Starting ${mode === 'single' ? 'single-session run' : 'parallel swarm'} (${plan.nodes.length} nodes, ${waves.length} waves, concurrency=${concurrency}, maxRetries=${maxRetries})`);

  const failedSet = new Set<string>();
  const waitingSet = new Set<string>();
  const startedSet = new Set<string>();

  const runNode = async (node: PlanNode, handle: WorktreeHandle): Promise<NodeOutcome> => {
          if (setupCmd) {
            console.log(`[${node.id}] Running setupCommand: ${setupCmd}`);
            const setupRes = await runTestCommandAsync(setupCmd, handle.dir, timeoutMs);
            if (setupRes.exitCode !== 0) {
              console.error(`[${node.id}] SETUP FAILED (exit ${setupRes.exitCode}):\n${setupRes.stderr || setupRes.stdout}`);
              return { ok: false, node, handle, stop: 'failed' };
            }
          }

          // Answers to this node's earlier tier-3 questions are appended to its prompt (v0.4).
          const answers = answersForNode(repoRoot, node.id);
          let qaFeedback = readQaFeedback(repoRoot, node.id);
          if (node.id === SINGLE_NODE_ID) {
            const parts: string[] = [];
            for (const pn of plan.nodes) {
              const t = readQaFeedback(repoRoot, pn.id);
              if (t) parts.push(`### ${pn.id}\n${t}`);
            }
            if (qaFeedback) parts.push(qaFeedback);
            qaFeedback = parts.join('\n\n');
          }
          let nodePrompt = node.prompt;
          if (answers.length > 0) {
            nodePrompt += `\n\n[Bastion - Human Answers]\n${answers
              .map((a) => `Q (${a.id}): ${a.question}\nA: ${a.answer ?? ''}`)
              .join('\n\n')}`;
          }
          if (qaFeedback) nodePrompt += `\n\n[Bastion - QA Feedback, fix these]\n${qaFeedback}`;
          const nodeForAgent: PlanNode = nodePrompt === node.prompt ? node : { ...node, prompt: nodePrompt };

          let feedback = '';
          for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
            const hit = opts.budget === false ? null : checkBudget({ agentCalls, minutes: minutesUsed() }, limits);
            if (hit) {
              budgetHit = hit;
              console.error(`[${node.id}] Budget limit reached (${hit}); not starting attempt ${attempt}.`);
              return { ok: false, node, handle, stop: 'budget' };
            }

            const logName = nextAttemptLogName(logsDir, node.id);
            const logFile = path.join(logsDir, logName);
            const promptFile = path.join(logsDir, `${node.id}-prompt.txt`);
            console.log(`[${node.id}] Attempt ${attempt}/${maxRetries + 1} in ${handle.branch} (log: .bastion/logs/${logName})`);

            agentCalls++;
            const agentRes = await runAgentAsync(
              agentCmd,
              nodeForAgent,
              handle.dir,
              attempt,
              feedback,
              logFile,
              promptFile,
              timeoutMs,
              repoRoot,
              opts.questions === false
            );
            saveState();

            // Collect outbox: tier-2 decisions go to the ledger; tier-3 questions pause this node only.
            const box = collectOutbox(handle.dir, node.id);
            appendDecisions(repoRoot, node.id, box.decisions);
            const opened = openQuestions(repoRoot, node.id, box.questions);
            if (opened.length > 0) {
              blockedSet.add(node.id);
              saveState();
              console.error(`[${node.id}] Asked ${opened.length} tier-3 question(s); pausing this node until answered.`);
              return { ok: false, node, handle, stop: 'blocked' };
            }

            if (agentRes.exitCode !== 0) {
              feedback = agentRes.timedOut
                ? `Agent timed out after ${Math.round(timeoutMs / 60_000)}m.`
                : `Agent command exited with ${agentRes.exitCode}.\n${agentRes.output.slice(-800)}`;
              console.error(`[${node.id}] Agent exited ${agentRes.exitCode}, retrying...`);
              continue;
            }

            // Check if the agent filed a test_defect dispute instead of trying to cheat
            const disputeFile = path.join(handle.dir, '.bastion', 'disputes', `${node.id}.md`);
            if (fs.existsSync(disputeFile)) {
              const reason = fs.readFileSync(disputeFile, 'utf8').trim();
              console.error(`[${node.id}] DISPUTE FILED (.bastion/disputes/${node.id}.md) — pausing node for human review:\n${reason}`);
              return { ok: false, node, handle, stop: 'failed' };
            }

            const gateRes = await gateSlots.run(() => runGateAsync({
              cwd: handle.dir,
              baseRef,
              testCommandOverride: node.testCommand,
            }));

            if (gateRes.exitCode === 0) {
              if (!stageSafeWorktreeFiles(handle.dir, node.id)) {
                return { ok: false, node, handle, stop: 'failed' };
              }
              console.log(`[${node.id}] GATE PASS on attempt ${attempt}.`);
              return { ok: true, node, handle };
            }

            feedback = gateRes.feedback;
            console.error(`[${node.id}] Gate failed on attempt ${attempt}, feeding back error to agent...`);
          }

          return { ok: false, node, handle, stop: 'failed' };
  };

  const planIds = new Set(plan.nodes.map((n) => n.id));
  const isReady = (n: PlanNode) =>
    !completedSet.has(n.id) &&
    !startedSet.has(n.id) &&
    !failedSet.has(n.id) &&
    !waitingSet.has(n.id) &&
    (n.dependsOn ?? []).every((d) => completedSet.has(d)) &&
    (extraDeps?.[n.id] ?? []).every((d) => !planIds.has(d) || completedSet.has(d));

  const running = new Map<string, Promise<void>>();

  const startNode = (node: PlanNode) => {
    startedSet.add(node.id);
    runningSet.add(node.id);
    saveState();
    const p = (async () => {
      let handle: WorktreeHandle | undefined;
      try {
        const currentHead = resolveRef('HEAD', repoRoot)!;
        handle = createNodeWorktree(repoRoot, currentHead, node.id);
        const out = await runNode(node, handle);
        if (out.ok) {
          console.log(`[bastion] Merging ${handle.branch} -> ${integrationBranch}...`);
          mergeNodeBranch(repoRoot, handle, node.title);
          const doneIds = node.id === SINGLE_NODE_ID ? plan.nodes.map((n) => n.id) : [node.id];
          for (const id of node.id === SINGLE_NODE_ID ? [...doneIds, SINGLE_NODE_ID] : doneIds) {
            if (id !== SINGLE_NODE_ID) completedSet.add(id);
            const fb = path.join(repoRoot, QA_FEEDBACK_DIR, `${id}.md`);
            if (fs.existsSync(fb)) fs.rmSync(fb, { force: true });
          }
          blockedSet.delete(node.id);
        } else if (out.stop === 'blocked') {
          waitingSet.add(node.id);
          blockedSet.add(node.id);
        } else if (out.stop === 'failed') {
          failedSet.add(node.id);
          blockedSet.delete(node.id);
        }
      } catch (err) {
        console.error(`[${node.id}] ERROR: ${err instanceof Error ? err.message : String(err)}`);
        failedSet.add(node.id);
        blockedSet.delete(node.id);
      } finally {
        if (handle) removeNodeWorktree(repoRoot, handle);
        runningSet.delete(node.id);
        saveState();
      }
    })();
    running.set(node.id, p);
    void p.then(() => running.delete(node.id));
  };

  for (;;) {
    while (!budgetHit && running.size < Math.max(1, concurrency)) {
      const node = runNodes.find((n) => {
        if (!isReady(n)) return false;
        if (hasOpenQuestion(repoRoot, n.id)) {
          waitingSet.add(n.id);
          blockedSet.add(n.id);
          saveState();
          console.log(`[${n.id}] Has an open question in the inbox; not running it until answered.`);
          return false;
        }
        return true;
      });
      if (!node) break;
      startNode(node);
    }
    if (running.size === 0) break;
    await Promise.race([...running.values()]);
  }

  if (!plan.nodes.every((n) => completedSet.has(n.id))) {
    saveState();
    if (budgetHit) {
      console.error(`\n[bastion] BUDGET EXHAUSTED (${budgetHit}): ${agentCalls} agent call(s), ${minutesUsed().toFixed(1)} min used.`);
      console.error('[bastion] Progress saved. Raise the limit and continue with: bastion run --resume --max-calls <n> --max-minutes <n>');
      return EXIT_BUDGET;
    }
    if (failedSet.size > 0) {
      console.error(`\n[bastion] Failed: ${[...failedSet].join(', ')}`);
      console.error('[bastion] Inspect logs under .bastion/logs/. Fix and resume with: bastion run --resume');
      return EXIT_FAILED;
    }
    if (waitingSet.size > 0) {
      console.error(`\n[bastion] Waiting for answers: ${[...waitingSet].join(', ')}. Answer with: bastion answer <id> "<text>", then bastion run --resume`);
      return EXIT_WAITING;
    }
    console.error('[bastion] Some nodes could not be scheduled (unsatisfiable dependencies).');
    return EXIT_FAILED;
  }

  console.log(`\n[bastion] All nodes merged into ${integrationBranch}! Running final verification (${verifyRuns}x)...`);
  for (let i = 1; i <= verifyRuns; i++) {
    const res = await runTestCommandAsync(config.testCommand, repoRoot, timeoutMs);
    if (res.exitCode !== 0) {
      console.error(`[bastion] Final verification ${i}/${verifyRuns} FAILED (exit ${res.exitCode}).`);
      return EXIT_FAILED;
    }
    console.log(`[bastion] Final verification ${i}/${verifyRuns} PASS (${res.durationMs}ms).`);
  }

  console.log(`\n[bastion] SWARM COMPLETE on branch "${integrationBranch}".`);
  console.log(`  Review and merge when ready: git checkout ${baseRef} && git merge --no-ff ${integrationBranch}`);
  return 0;
  } finally {
    saveState();
    if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
  }
}
