import * as fs from 'node:fs';
import * as path from 'node:path';
import { readDecisions } from './ledger.js';
import { readInbox } from './inbox.js';

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function safeList<T>(fn: () => T[]): T[] {
  try {
    const v = fn();
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/**
 * The three lines of `bastion summary` (what happened while you were away):
 *   1. completed / total plan nodes
 *   2. tier-2 decisions made for you
 *   3. tier-3 questions waiting for you
 * Reads .bastion/run-state.json, .bastion/plan.json, decisions.json and inbox.json.
 * Missing files count as zero; it never throws for a fresh repo.
 */
export function summaryLines(repoRoot: string): string[] {
  const plan = readJson(path.join(repoRoot, '.bastion', 'plan.json')) as { nodes?: unknown } | undefined;
  const state = readJson(path.join(repoRoot, '.bastion', 'run-state.json')) as { completedNodes?: unknown; runningNodes?: unknown } | undefined;
  const total = Array.isArray(plan?.nodes) ? plan.nodes.length : 0;
  const completed = Array.isArray(state?.completedNodes) ? state.completedNodes.length : 0;
  const decisions = safeList(() => readDecisions(repoRoot)).length;
  const open = safeList(() => readInbox(repoRoot)).filter((i) => i.status === 'open').length;
  const lines = [
    `Done: ${completed}/${total} nodes`,
    `Decided for you: ${decisions} (bastion decisions)`,
    `Waiting for you: ${open} (bastion answer <id> "<answer>")`,
  ];
  const running = Array.isArray(state?.runningNodes) ? state.runningNodes.filter((n): n is string => typeof n === 'string') : [];
  if (running.length > 0) lines.push(`Running now: ${running.join(', ')}`);
  return lines;
}
