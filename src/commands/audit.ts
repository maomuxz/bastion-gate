import {
  CONFIG_REL_PATH,
  LOCK_REL_PATH,
  readConfigFromRef,
  readLockFromRef,
} from '../config.js';
import { execGit, getChangedFilesBetween, getRepoRoot } from '../git.js';
import { matchesAnyGlob } from '../runner.js';

export interface AuditOptions {
  cwd: string;
  limit?: number;
}

/**
 * Post-hoc audit for local-only repos without CI branch protection:
 * inspects recent merge commits (or linear commits) to verify no commit modified
 * locked test/config files without an authorized lock amendment.
 */
export function runAudit(opts: AuditOptions): number {
  const repoRoot = getRepoRoot(opts.cwd);
  if (!repoRoot) {
    console.error('[bastion] Error: not inside a git repository.');
    return 1;
  }

  const maxCount = String(opts.limit ?? 20);
  const mergesRes = execGit(['log', '--merges', '--format=%H %s', '-n', maxCount], repoRoot);
  const commits = mergesRes.ok && mergesRes.stdout.trim()
    ? mergesRes.stdout.split(/\r?\n/).filter(Boolean)
    : [];

  if (commits.length === 0) {
    console.log('[bastion] No merge commits found to audit.');
    return 0;
  }

  let failures = 0;
  for (const line of commits) {
    const spaceIdx = line.indexOf(' ');
    const sha = spaceIdx === -1 ? line : line.slice(0, spaceIdx);
    const subject = spaceIdx === -1 ? '' : line.slice(spaceIdx + 1);
    const parentRef = `${sha}^1`;

    let baseConfig;
    let baseLock;
    try {
      baseConfig = readConfigFromRef(parentRef, repoRoot);
      baseLock = readLockFromRef(parentRef, repoRoot);
    } catch {
      // Bastion was not initialized on this merge's parent; skip
      continue;
    }

    const lockedSet = new Set(baseLock.lockedFiles.map((f) => f.path));
    const patterns = [...baseConfig.lockedGlobs, ...baseConfig.extraLockedPaths];
    const changed = getChangedFilesBetween(parentRef, sha, repoRoot);

    const touched = changed.filter(
      (rel) =>
        rel === CONFIG_REL_PATH ||
        rel === LOCK_REL_PATH ||
        lockedSet.has(rel) ||
        matchesAnyGlob(rel, patterns)
    );

    if (touched.length > 0) {
      failures++;
      console.error(`[FAIL] ${sha.slice(0, 8)} (${subject}) modified locked files:`);
      for (const f of touched) console.error(`  - ${f}`);
    } else {
      console.log(`[PASS] ${sha.slice(0, 8)} (${subject})`);
    }
  }

  if (failures > 0) {
    console.error(`\n[bastion] Audit found ${failures} merge(s) that bypassed locked scope.`);
    return 1;
  }

  console.log('\n[bastion] Audit complete: no locked-scope bypasses detected.');
  return 0;
}
