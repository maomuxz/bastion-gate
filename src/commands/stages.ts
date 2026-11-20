// Shared types and paths for the v0.5 / v1.0 stage commands (map, review, scaffold, tests, qa, flow, regress).
// All commands: return 0 on success, 1 on failure, EXIT_WAITING (2) when a human step is needed.

export interface MapOptions {
  cwd: string;
  /** The one-sentence (or longer) requirement. Required unless `parent` is set. */
  requirement?: string;
  /** Split this existing map node into a sub-map (recursive decomposition). */
  parent?: string;
  /** v1.1: 1 = one planner only, no blind map (city tier). Default 2. */
  planners?: 1 | 2;
  timeoutMinutes?: number;
}
export interface ReviewOptions { cwd: string; approve?: boolean }
export interface ScaffoldOptions { cwd: string; timeoutMinutes?: number }
export interface TestsOptions {
  cwd: string;
  concurrency?: number;
  lock?: boolean;
  timeoutMinutes?: number;
  /** v1.1: set false to skip the gap check before locking (default: on whenever `lock` is set). */
  gaps?: boolean;
}
export interface GapsOptions { cwd: string; timeoutMinutes?: number; probe?: boolean; drop?: string }
export interface QaOptions {
  cwd: string;
  timeoutMinutes?: number;
  /** v1.1: check this ref instead of the run's integration branch (required meaning: see runQa). */
  ref?: string;
}
export interface ContractOptions { cwd: string; requirement: string; timeoutMinutes?: number }
export interface FlowOptions {
  cwd: string;
  requirement?: string;
  /** v1.1: wall tier, fixed at the first call (see src/tier.ts). */
  tier?: import('../tier.js').Tier;
}
export interface RegressOptions { cwd: string; command: string; base?: string }

export interface QaFinding { node: string; kind: 'code' | 'test_defect'; issue: string }
/** v1.1: one black-box case the QA role wrote and ran; `command` is run again by bastion from the checkout root and must exit 0. */
export interface QaCase { name: string; rule: string; node: string; command: string }
export interface QaCaseRun extends QaCase { exitCode: number; timedOut: boolean; outputTail: string }
export interface QaReport { verdict: 'pass' | 'fail'; findings: QaFinding[]; cases: QaCase[] }
export interface RegressResult {
  /** First bastion merge on the first-parent history where `command` fails while its first parent passes. */
  culprit?: { sha: string; subject: string };
  /** Number of commits on which the command was run. */
  checked: number;
  message: string;
}

export const BRIEF_REL_PATH = '.bastion/brief.md';
export const APPROVAL_REL_PATH = '.bastion/approval.json';
export const QA_REPORT_REL_PATH = '.bastion/qa.json';
export const QA_DISPUTES_REL_PATH = '.bastion/qa-disputes.md';
export const QA_RUN_REL_PATH = '.bastion/qa-run.json';
export const QA_CASES_REL_DIR = '.bastion/qa-cases';
export const REQUIREMENT_REL_PATH = '.bastion/requirement.md';
export const FLOW_STATE_REL_PATH = '.bastion/flow-state.json';
