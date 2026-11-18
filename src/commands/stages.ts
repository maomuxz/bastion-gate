// Shared types and paths for the v0.5 / v1.0 stage commands (map, review, scaffold, tests, qa, flow, regress).
// All commands: return 0 on success, 1 on failure, EXIT_WAITING (2) when a human step is needed.

export interface MapOptions {
  cwd: string;
  /** The one-sentence (or longer) requirement. Required unless `parent` is set. */
  requirement?: string;
  /** Split this existing map node into a sub-map (recursive decomposition). */
  parent?: string;
  timeoutMinutes?: number;
}
export interface ReviewOptions { cwd: string; approve?: boolean }
export interface ScaffoldOptions { cwd: string; timeoutMinutes?: number }
export interface TestsOptions { cwd: string; concurrency?: number; lock?: boolean; timeoutMinutes?: number }
export interface QaOptions { cwd: string; timeoutMinutes?: number }
export interface FlowOptions { cwd: string; requirement?: string }
export interface RegressOptions { cwd: string; command: string; base?: string }

export interface QaFinding { node: string; kind: 'code' | 'test_defect'; issue: string }
export interface QaReport { verdict: 'pass' | 'fail'; findings: QaFinding[] }
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
export const FLOW_STATE_REL_PATH = '.bastion/flow-state.json';
