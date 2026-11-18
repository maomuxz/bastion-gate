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
import { execGit, getDirtyFiles, getRepoRoot, resolveRef } from '../git.js';
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
import { runTestCommandAsync } from '../runner.js';
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
}

/** v1.0: QA feedback for a reopened node (written by `bastion qa`, consumed on the next attempt). */
const QA_FEEDBACK_DIR = path.join('.bastion', 'feedback');
function readQaFeedback(repoRoot: string, nodeId: string): string {
  const p = path.join(repoRoot, QA_FEEDBACK_DIR, `${nodeId}.md`);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim() : '';
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
    ['-c', 'user.name=bastion', '-c', 'user.email=bastion@local', 'commit', '-m', `feat(${nodeId}): apply verified changes`],
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
  repoRoot: string
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

    const child = spawn(cmd, {
      cwd: worktreeDir,
      env,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    let lineBuf = '';
    let timedOut = false;

    const timer = timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          logStream.write(`\n[bastion] Agent timed out after ${timeoutMs}ms.\n`);
          child.kill();
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
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (lineBuf.trim()) console.log(`  [${node.id}] ${lineBuf}`);
      logStream.end();
      resolve({ exitCode: timedOut ? 124 : (code ?? 1), output, timedOut });
    });
  });
}

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
    const checkoutRes = execGit(['checkout', integrationBranch], repoRoot);
    if (!checkoutRes.ok) {
      console.error(`[bastion] Error checking out ${integrationBranch}: ${checkoutRes.stderr}`);
      return 1;
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
          const qaFeedback = readQaFeedback(repoRoot, node.id);
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
            const hit = checkBudget({ agentCalls, minutes: minutesUsed() }, limits);
            if (hit) {
              budgetHit = hit;
              console.error(`[${node.id}] Budget limit reached (${hit}); not starting attempt ${attempt}.`);
              return { ok: false, node, handle, stop: 'budget' };
            }

            const logFile = path.join(logsDir, `${node.id}-attempt-${attempt}.log`);
            const promptFile = path.join(logsDir, `${node.id}-prompt.txt`);
            console.log(`[${node.id}] Attempt ${attempt}/${maxRetries + 1} in ${handle.branch} (log: .bastion/logs/${node.id}-attempt-${attempt}.log)`);

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
              repoRoot
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

  const isReady = (n: PlanNode) =>
    !completedSet.has(n.id) &&
    !startedSet.has(n.id) &&
    !failedSet.has(n.id) &&
    !waitingSet.has(n.id) &&
    (n.dependsOn ?? []).every((d) => completedSet.has(d));

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
          for (const id of doneIds) {
            completedSet.add(id);
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
