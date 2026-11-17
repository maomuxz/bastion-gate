import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
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
import { runTestCommandAsync } from '../runner.js';
import { runGateAsync } from './gate.js';

export interface RunOptions {
  cwd: string;
  baseRef?: string;
  agentCommand?: string;
  setupCommand?: string;
  concurrency?: number;
  maxRetries?: number;
  verifyRuns?: number;
  timeoutMinutes?: number;
}

interface AgentExecResult {
  exitCode: number;
  output: string;
  timedOut: boolean;
}

function runAgentAsync(
  commandTemplate: string,
  node: PlanNode,
  worktreeDir: string,
  attempt: number,
  feedback: string,
  logFile: string,
  promptFile: string,
  timeoutMs: number
): Promise<AgentExecResult> {
  return new Promise((resolve) => {
    const fullPrompt = feedback
      ? `${node.prompt}\n\n[Bastion Gate Feedback - Fix Required]\n${feedback}`
      : node.prompt;

    fs.mkdirSync(path.dirname(promptFile), { recursive: true });
    fs.writeFileSync(promptFile, fullPrompt, 'utf8');
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const logStream = fs.createWriteStream(logFile, { flags: 'w' });

    // Prefer {promptFile} or $BASTION_PROMPT; if user wrote {prompt}, pass via env-safe expansion
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
    };
    delete env.NODE_TEST_CONTEXT;

    const child = spawn(cmd, {
      cwd: worktreeDir,
      env,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
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
    };

    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      logStream.end();
      resolve({ exitCode: timedOut ? 124 : (code ?? 1), output, timedOut });
    });
  });
}

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIdx = 0;

  async function next() {
    while (nextIdx < items.length) {
      const idx = nextIdx++;
      results[idx] = await worker(items[idx]);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => next());
  await Promise.all(workers);
  return results;
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

  const blockedTier3 = plan.nodes.filter((n) => n.tier === 3 && !n.approved);
  if (blockedTier3.length > 0) {
    console.error('[bastion] RUN BLOCKED: tier-3 node(s) require human approval ("approved": true):');
    for (const n of blockedTier3) console.error(`  - ${n.id}: ${n.title}`);
    return 1;
  }

  const agentCmd = opts.agentCommand ?? config.agentCommand;
  if (!agentCmd) {
    console.error('[bastion] Error: no agentCommand configured. Pass --agent "<cmd>" or set "agentCommand" in .bastion/config.json.');
    return 1;
  }

  const baseRef = opts.baseRef ?? config.baseBranch;
  if (!resolveRef(baseRef, repoRoot)) {
    console.error(`[bastion] Error: cannot resolve baseline ref "${baseRef}".`);
    return 1;
  }

  const dirty = getDirtyFiles(repoRoot);
  if (dirty.length > 0) {
    console.error('[bastion] Error: working tree is not clean. Commit or stash changes before `bastion run`.');
    return 1;
  }

  const setupCmd = opts.setupCommand ?? config.setupCommand;
  const concurrency = opts.concurrency ?? config.concurrency ?? 2;
  const maxRetries = opts.maxRetries ?? config.maxRetries ?? 2;
  const verifyRuns = opts.verifyRuns ?? config.verifyRuns ?? 1;
  const timeoutMs = (opts.timeoutMinutes ?? config.timeoutMinutes ?? 20) * 60_000;

  // Create an isolated integration branch so partial wave failures never pollute baseBranch
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const integrationBranch = `bastion/run-${stamp}`;
  const checkoutRes = execGit(['checkout', '-b', integrationBranch], repoRoot);
  if (!checkoutRes.ok) {
    console.error(`[bastion] Error creating integration branch ${integrationBranch}: ${checkoutRes.stderr}`);
    return 1;
  }

  const logsDir = path.join(repoRoot, '.bastion', 'logs');
  console.log(`[bastion] Integration branch: ${integrationBranch}`);
  console.log(`[bastion] Starting parallel swarm (${plan.nodes.length} nodes, ${waves.length} waves, concurrency=${concurrency}, maxRetries=${maxRetries})`);

  for (let w = 0; w < waves.length; w++) {
    const wave = waves[w];
    console.log(`\n=== Wave ${w + 1}/${waves.length}: [${wave.map((n) => n.id).join(', ')}] ===`);

    const currentHead = resolveRef('HEAD', repoRoot)!;
    const handles: WorktreeHandle[] = wave.map((node) => createNodeWorktree(repoRoot, currentHead, node.id));

    try {
      const outcomes = await runWithConcurrency(
        wave.map((node, i) => ({ node, handle: handles[i] })),
        concurrency,
        async ({ node, handle }) => {
          if (setupCmd) {
            console.log(`[${node.id}] Running setupCommand: ${setupCmd}`);
            const setupRes = await runTestCommandAsync(setupCmd, handle.dir, timeoutMs);
            if (setupRes.exitCode !== 0) {
              console.error(`[${node.id}] SETUP FAILED (exit ${setupRes.exitCode}):\n${setupRes.stderr || setupRes.stdout}`);
              return { ok: false, node, handle };
            }
          }

          let feedback = '';
          for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
            const logFile = path.join(logsDir, `${node.id}-attempt-${attempt}.log`);
            const promptFile = path.join(logsDir, `${node.id}-prompt.txt`);
            console.log(`[${node.id}] Attempt ${attempt}/${maxRetries + 1} in ${handle.branch} (log: .bastion/logs/${node.id}-attempt-${attempt}.log)`);

            const agentRes = await runAgentAsync(
              agentCmd,
              node,
              handle.dir,
              attempt,
              feedback,
              logFile,
              promptFile,
              timeoutMs
            );

            if (agentRes.exitCode !== 0) {
              feedback = agentRes.timedOut
                ? `Agent timed out after ${Math.round(timeoutMs / 60_000)}m.`
                : `Agent command exited with ${agentRes.exitCode}.\n${agentRes.output.slice(-800)}`;
              console.error(`[${node.id}] Agent exited ${agentRes.exitCode}, retrying...`);
              continue;
            }

            const gateRes = await runGateAsync({
              cwd: handle.dir,
              baseRef,
              testCommandOverride: node.testCommand,
            });

            if (gateRes.exitCode === 0) {
              if (getDirtyFiles(handle.dir).length > 0) {
                const addRes = execGit(['add', '-A'], handle.dir);
                if (!addRes.ok) {
                  console.error(`[${node.id}] git add failed: ${addRes.stderr}`);
                  return { ok: false, node, handle };
                }
                const commitRes = execGit(
                  ['-c', 'user.name=bastion', '-c', 'user.email=bastion@local', 'commit', '-m', `feat(${node.id}): ${node.title}`],
                  handle.dir
                );
                if (!commitRes.ok) {
                  console.error(`[${node.id}] git commit failed: ${commitRes.stderr}`);
                  return { ok: false, node, handle };
                }
              }
              console.log(`[${node.id}] GATE PASS on attempt ${attempt}.`);
              return { ok: true, node, handle };
            }

            feedback = gateRes.feedback;
            console.error(`[${node.id}] Gate failed on attempt ${attempt}, feeding back error to agent...`);
          }

          return { ok: false, node, handle };
        }
      );

      const failed = outcomes.filter((o) => !o.ok);
      if (failed.length > 0) {
        console.error(`\n[bastion] Wave ${w + 1} failed: ${failed.map((f) => f.node.id).join(', ')}`);
        console.error(`[bastion] Inspect logs under .bastion/logs/. Your original branch "${baseRef}" was not modified.`);
        return 1;
      }

      for (const { node, handle } of outcomes) {
        console.log(`[bastion] Merging ${handle.branch} -> ${integrationBranch}...`);
        mergeNodeBranch(repoRoot, handle, node.title);
      }
    } finally {
      for (const handle of handles) {
        removeNodeWorktree(repoRoot, handle);
      }
    }
  }

  console.log(`\n[bastion] All waves merged into ${integrationBranch}! Running final verification (${verifyRuns}x)...`);
  for (let i = 1; i <= verifyRuns; i++) {
    const res = await runTestCommandAsync(config.testCommand, repoRoot, timeoutMs);
    if (res.exitCode !== 0) {
      console.error(`[bastion] Final verification ${i}/${verifyRuns} FAILED (exit ${res.exitCode}).`);
      return 1;
    }
    console.log(`[bastion] Final verification ${i}/${verifyRuns} PASS (${res.durationMs}ms).`);
  }

  console.log(`\n[bastion] SWARM COMPLETE on branch "${integrationBranch}".`);
  console.log(`  Review and merge when ready: git checkout ${baseRef} && git merge --no-ff ${integrationBranch}`);
  return 0;
}
