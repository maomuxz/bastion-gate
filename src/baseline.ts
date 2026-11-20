// v1.1: baseline files (config, lock, plan, map, interfaces, acceptance) may only change on the base branch.
// When the integration branch itself differs from the base in one of them, a human did that - no construction AI can
// repair it, so the run must stop and ask instead of feeding the gate failure to an AI and burning retries.

import { ACCEPTANCE_REL_PATH, CONFIG_REL_PATH, INTERFACES_REL_PATH, LOCK_REL_PATH, MAP_REL_PATH, PLAN_REL_PATH } from './config.js';
import { execGit } from './git.js';

export const BASELINE_FILES: readonly string[] = [
  CONFIG_REL_PATH, LOCK_REL_PATH, PLAN_REL_PATH, MAP_REL_PATH, INTERFACES_REL_PATH, ACCEPTANCE_REL_PATH,
];

/**
 * Baseline files whose content at `ref` differs from their content at `baseRef` (a file present on only one side
 * counts as different), in BASELINE_FILES order. Compares the two commits directly (`git diff --name-only <baseRef> <ref>
 * -- <files>`), not the working tree. Identical -> []. A git failure (unknown ref) -> [].
 */
export function baselineDrift(repoRoot: string, baseRef: string, ref: string): string[] {
  const res = execGit(['diff', '--name-only', baseRef, ref, '--', ...BASELINE_FILES], repoRoot);
  if (!res.ok) return [];
  const changed = new Set(res.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
  return BASELINE_FILES.filter((f) => changed.has(f));
}

/**
 * The two lines printed when drift stops a run:
 * `[bastion] run: baseline file(s) differ between <baseRef> and <branch>: <files joined by ', '>`
 * `[bastion] run: this needs a human, not a retry: commit the change on <baseRef> and merge <baseRef> into <branch> (or revert it), then run: bastion run --resume`
 */
export function driftMessage(files: string[], baseRef: string, branch: string): string[] {
  return [
    `[bastion] run: baseline file(s) differ between ${baseRef} and ${branch}: ${files.join(', ')}`,
    `[bastion] run: this needs a human, not a retry: commit the change on ${baseRef} and merge ${baseRef} into ${branch} (or revert it), then run: bastion run --resume`,
  ];
}
