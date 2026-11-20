// v1.1: the wall. These five pieces are the kernel of bastion and are the same in every tier:
//
//   lock   - red-first lock of the acceptance tests            (runLock)
//   gaps   - a critic compares the requirement with the tests   (findGaps / runGaps), before the lock
//   gate   - nobody touched the locked tests or the baseline    (runGate / runGateAsync)
//   qa     - black-box cases really run against the product     (runQa)
//   audit  - history check: no merge bypassed the locked scope  (runAudit)
//
// The kernel works in a repo that has only `bastion init` + a lock: no map, no plan, no worktrees, no swarm.
// Planning (map, review, contract, scaffold), concurrency (run, slots, split) and the flow are add-ons that call
// the kernel; the kernel must never import them. KERNEL_MODULES lists the kernel's source files and
// KERNEL_FORBIDDEN_IMPORTS the add-on modules that no kernel file (nor anything a kernel file imports) may import.

export { runLock } from './commands/lock.js';
export { findGaps, runGaps } from './commands/gaps.js';
export { runGate, runGateAsync } from './commands/gate.js';
export { runQa } from './commands/qa.js';
export { runAudit } from './commands/audit.js';

export const KERNEL_MODULES: readonly string[] = [
  'src/wall.ts',
  'src/commands/lock.ts',
  'src/commands/gaps.ts',
  'src/commands/gate.ts',
  'src/commands/qa.ts',
  'src/commands/audit.ts',
];

export const KERNEL_FORBIDDEN_IMPORTS: readonly string[] = [
  'src/commands/run.ts',
  'src/commands/flow.ts',
  'src/commands/map.ts',
  'src/commands/review.ts',
  'src/commands/contract.ts',
  'src/commands/scaffold.ts',
  'src/commands/tests.ts',
  'src/commands/plan.ts',
  'src/orchestrator/dag.ts',
  'src/orchestrator/worktree.ts',
  'src/single.ts',
  'src/slots.ts',
  'src/split.ts',
  'src/tier.ts',
  'src/map.ts',
];
// src/state.ts (the tiny run-progress file reader) is allowed: `bastion qa` reopens blocks of a run when one exists.
