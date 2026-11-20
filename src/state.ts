import * as fs from 'node:fs';
import * as path from 'node:path';

export const RUN_STATE_REL_PATH = '.bastion/run-state.json';

/** Persistent progress of a `bastion run`, shared by --resume, budget, inbox and summary. */
export interface RunState {
  integrationBranch: string;
  baseRef: string;
  completedNodes: string[];
  /** v0.4: number of agent invocations so far (including retries), across resumes. */
  agentCalls?: number;
  /** v0.4: wall-clock minutes spent in previous run sessions plus the current one so far. */
  accumulatedMinutes?: number;
  /** v0.4: nodes paused because they asked a tier-3 question that is still open. */
  blockedNodes?: string[];
  /** v0.4.1: nodes whose agent/gate is running right now (empty when idle). */
  runningNodes?: string[];
  /** v1.1: extra scheduling edges added by `bastion reopen --before`: extraDeps[node] must be complete before node starts. */
  extraDeps?: Record<string, string[]>;
  /** v0.4: set when the last session stopped because a budget limit was hit. */
  budgetHit?: 'calls' | 'minutes';
}

export function readRunState(repoRoot: string): RunState | null {
  const p = path.join(repoRoot, RUN_STATE_REL_PATH);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')) as RunState;
  } catch {
    return null;
  }
}

export function writeRunState(repoRoot: string, state: RunState): void {
  const p = path.join(repoRoot, RUN_STATE_REL_PATH);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(state, null, 2) + '\n', 'utf8');
}
