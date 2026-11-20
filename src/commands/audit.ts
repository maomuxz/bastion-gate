import { spawnSync } from 'node:child_process';
import {
  CONFIG_REL_PATH,
  LOCK_REL_PATH,
  readConfigFromRef,
  readLockFromRef,
} from '../config.js';
import { execGit, getChangedFilesBetween, getRepoRoot } from '../git.js';
import { hashMatches, matchesAnyGlob } from '../runner.js';

/**
 * True when a merge that touched locked files is an authorised lock amendment (v1.0, F8):
 * the lock.json at `sha` has more `amendments` than the lock.json at `sha^1`, and every touched path
 * other than .bastion/lock.json is listed in the new lock's lockedFiles with a sha256 equal to that
 * file's content at `sha`. Touching .bastion/config.json is never authorised. Missing/unreadable locks -> false.
 * v1.1: "equal" means hashMatches(content at sha, recorded sha256) from src/runner.ts, so a lock written on a CRLF
 * checkout still matches the LF blob git stores (this used to be reported as a bypass on Windows).
 */
export function isAuthorizedAmendment(repoRoot: string, sha: string, touched: string[]): boolean {
  try {
    if (touched.includes(CONFIG_REL_PATH)) return false;
    const newLock = readLockFromRef(sha, repoRoot);
    const oldLock = readLockFromRef(`${sha}^1`, repoRoot);
    if ((newLock.amendments?.length ?? 0) <= (oldLock.amendments?.length ?? 0)) return false;
    const recorded = new Map(newLock.lockedFiles.map((f) => [f.path, f.sha256]));
    for (const rel of touched) {
      if (rel === LOCK_REL_PATH) continue;
      const expected = recorded.get(rel);
      if (!expected) return false;
      const res = spawnSync('git', ['show', `${sha}:${rel}`], {
        cwd: repoRoot,
        maxBuffer: 256 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (res.status !== 0 || !Buffer.isBuffer(res.stdout)) return false;
      if (!hashMatches(res.stdout, expected)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export interface AuditOptions {
  cwd: string;
  limit?: number;
}

/**
 * Post-hoc audit for local-only repos without CI branch protection:
 * inspects recent merge commits (or linear commits) to verify no commit modified
 * locked test/config files without an authorized lock amendment.
 */
/*
 * v1.1 hardening (round 5): a merge that cannot be checked is no longer skipped without a trace.
 * - A merge whose first parent has no readable .bastion config or lock prints
 *   `[SKIP] <first 8 chars of the sha> (<subject>) - its parent has no readable bastion config/lock` (same shape as
 *   the [PASS] lines).
 * - After the loop, when at least one merge was skipped and there was no failure, one more line follows the usual
 *   final line: `[bastion] Audit: <checked> merge(s) checked, <skipped> skipped (not covered by this audit).`
 * - When EVERY merge was skipped, the usual "no locked-scope bypasses detected" line is NOT printed (nothing was
 *   checked); instead `[bastion] Audit: no merge could be checked (<n> skipped).` is printed. Exit code stays 0.
 * With no skipped merge the output is exactly as before.
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
  let skipped = 0;
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
      // Bastion was not initialized on this merge's parent; skip, but leave a trace
      skipped++;
      console.log(`[SKIP] ${sha.slice(0, 8)} (${subject}) - its parent has no readable bastion config/lock`);
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

    if (touched.length > 0 && isAuthorizedAmendment(repoRoot, sha, touched)) {
      console.log(`[PASS] ${sha.slice(0, 8)} (${subject}) - authorised lock amendment`);
    } else if (touched.length > 0) {
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

  if (skipped === commits.length) {
    console.log(`\n[bastion] Audit: no merge could be checked (${skipped} skipped).`);
    return 0;
  }

  console.log('\n[bastion] Audit complete: no locked-scope bypasses detected.');
  if (skipped > 0) {
    console.log(
      `[bastion] Audit: ${commits.length - skipped} merge(s) checked, ${skipped} skipped (not covered by this audit).`
    );
  }
  return 0;
}
