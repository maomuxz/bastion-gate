import { execGit, toPosixPath } from './git.js';
import { matchesAnyGlob } from './runner.js';
const BASELINE_FILES = new Set([
    '.bastion/config.json',
    '.bastion/lock.json',
    '.bastion/plan.json',
    '.bastion/map.json',
    '.bastion/interfaces.md',
    '.bastion/acceptance.md',
]);
/**
 * Files that must block `bastion run` because the working tree is not clean (v1.0, F10).
 * - Modified, staged, deleted or renamed TRACKED files always block.
 * - UNTRACKED files block only when they match `lockedPatterns` (lockedGlobs + extraLockedPaths) or are a baseline
 *   bastion file (.bastion/config.json, lock.json, plan.json, map.json, interfaces.md, acceptance.md);
 *   other untracked files (logs, notes, scratch files) are ignored, because node worktrees are cut from HEAD.
 * - Gitignored files never block. Paths are repo-relative POSIX, in `git status` order.
 */
export function blockingDirtyFiles(repoRoot, lockedPatterns) {
    const res = execGit(['status', '--porcelain', '-uall'], repoRoot);
    if (!res.ok)
        throw new Error(`git status failed: ${res.stderr}`);
    const out = [];
    for (const line of res.stdout.split(/\r?\n/)) {
        if (!line.trim())
            continue;
        const status = line.slice(0, 2);
        const rawPath = line.slice(3).trim();
        const finalPath = rawPath.includes(' -> ') ? rawPath.split(' -> ').pop() : rawPath;
        const unquoted = finalPath.startsWith('"') && finalPath.endsWith('"') ? finalPath.slice(1, -1) : finalPath;
        const file = toPosixPath(unquoted);
        if (status === '!!')
            continue;
        if (status === '??' && !BASELINE_FILES.has(file) && !matchesAnyGlob(file, lockedPatterns))
            continue;
        out.push(file);
    }
    return out;
}
