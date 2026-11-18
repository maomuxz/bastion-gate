import { BastionConfig } from './config.js';

export interface BudgetLimits {
  maxAgentCalls?: number;
  maxMinutes?: number;
}

export interface BudgetUsage {
  agentCalls: number;
  minutes: number;
}

/** CLI flags (--max-calls / --max-minutes) override config.budget field by field. */
export function resolveBudgetLimits(config: BastionConfig, overrides: BudgetLimits): BudgetLimits {
  const out: BudgetLimits = {};
  const base = config.budget;
  const calls = overrides.maxAgentCalls ?? base?.maxAgentCalls;
  const minutes = overrides.maxMinutes ?? base?.maxMinutes;
  if (calls !== undefined) out.maxAgentCalls = calls;
  if (minutes !== undefined) out.maxMinutes = minutes;
  return out;
}

/** Which limit is reached (usage >= limit), or null if the next agent call may start. */
export function checkBudget(usage: BudgetUsage, limits: BudgetLimits): 'calls' | 'minutes' | null {
  if (limits.maxAgentCalls !== undefined && usage.agentCalls >= limits.maxAgentCalls) return 'calls';
  if (limits.maxMinutes !== undefined && usage.minutes >= limits.maxMinutes) return 'minutes';
  return null;
}
