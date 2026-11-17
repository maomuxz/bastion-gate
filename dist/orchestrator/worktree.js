import * as fs from 'node:fs';
import * as path from 'node:path';
import { execGit } from '../git.js';
/** Create an isolated git worktree and branch for a parallel agent node. */
export function createNodeWorktree(repoRoot, baseRef, nodeId) {
    const safeId = nodeId.replace(/[^a-zA-Z0-9_-]/g, '-');
    const branch = `bastion/${safeId}`;
    const dir = path.join(repoRoot, '.bastion', 'worktrees', safeId);
    // Clean up stale worktree or branch if left over from an aborted run
    removeNodeWorktree(repoRoot, { nodeId, branch, dir });
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const res = execGit(['worktree', 'add', '-b', branch, dir, baseRef], repoRoot);
    if (!res.ok) {
        throw new Error(`Failed to create worktree for "${nodeId}": ${res.stderr}`);
    }
    return { nodeId, branch, dir };
}
/** Remove a node's temporary git worktree and branch. */
export function removeNodeWorktree(repoRoot, handle) {
    if (fs.existsSync(handle.dir)) {
        execGit(['worktree', 'remove', '--force', handle.dir], repoRoot);
        if (fs.existsSync(handle.dir)) {
            fs.rmSync(handle.dir, { recursive: true, force: true });
        }
    }
    execGit(['worktree', 'prune'], repoRoot);
    execGit(['branch', '-D', handle.branch], repoRoot);
}
/** Merge a verified node branch into the current integration branch with --no-ff. */
export function mergeNodeBranch(repoRoot, handle, title) {
    const res = execGit(['merge', '--no-ff', handle.branch, '-m', `bastion(${handle.nodeId}): ${title}`], repoRoot);
    if (!res.ok) {
        execGit(['merge', '--abort'], repoRoot);
        throw new Error(`Merge conflict integrating "${handle.nodeId}" (${handle.branch}): ${res.stderr}`);
    }
}
