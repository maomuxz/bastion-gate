// Shared types and paths for the v0.5 / v1.0 stage commands (map, review, scaffold, tests, qa, flow, regress).
// All commands: return 0 on success, 1 on failure, EXIT_WAITING (2) when a human step is needed.
export const BRIEF_REL_PATH = '.bastion/brief.md';
export const APPROVAL_REL_PATH = '.bastion/approval.json';
export const QA_REPORT_REL_PATH = '.bastion/qa.json';
export const QA_DISPUTES_REL_PATH = '.bastion/qa-disputes.md';
export const FLOW_STATE_REL_PATH = '.bastion/flow-state.json';
