import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readConfigFromDisk } from '../config.js';
import { execGit, getRepoRoot, resolveRef } from '../git.js';
/** Run `command` on `sha` in a temporary detached worktree; always removes it. True when the command exits 0. */
function passesAt(repoRoot, sha, command) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bastion-regress-wt-'));
    fs.rmSync(dir, { recursive: true, force: true });
    const add = execGit(['worktree', 'add', '--detach', dir, sha], repoRoot);
    if (!add.ok)
        throw new Error(`git worktree add failed: ${add.stderr}`);
    try {
        const res = spawnSync(command, { cwd: dir, shell: true, stdio: 'ignore' });
        return res.status === 0;
    }
    finally {
        execGit(['worktree', 'remove', '--force', dir], repoRoot);
        fs.rmSync(dir, { recursive: true, force: true });
        execGit(['worktree', 'prune'], repoRoot);
    }
}
/**
 * P9: walk merge commits on the first-parent history of HEAD after `base` (default config.baseBranch), run `command`
 * on each in a temporary detached worktree (oldest first, binary search allowed), and find the first merge where it fails
 * while its first parent passes. Worktrees are always removed. No culprit -> culprit undefined and an explanatory message.
 */
export function findRegression(opts) {
    const root = getRepoRoot(opts.cwd);
    if (!root)
        return { checked: 0, message: 'regress: not inside a git repository.' };
    const baseRef = opts.base ?? readConfigFromDisk(root).baseBranch;
    const base = resolveRef(baseRef, root);
    if (!base)
        return { checked: 0, message: `regress: cannot resolve base ref '${baseRef}'.` };
    const list = execGit(['rev-list', '--first-parent', '--merges', '--reverse', `${base}..HEAD`], root);
    const merges = list.ok ? list.stdout.split(/\r?\n/).filter(Boolean) : [];
    if (merges.length === 0)
        return { checked: 0, message: `regress: no merge commits on first-parent history after ${baseRef}.` };
    const cache = new Map();
    const check = (sha) => {
        let v = cache.get(sha);
        if (v === undefined) {
            v = passesAt(root, sha, opts.command);
            cache.set(sha, v);
        }
        return v;
    };
    // Binary search for the first failing merge (assumes failures persist once introduced).
    let first = -1;
    if (!check(merges[merges.length - 1])) {
        let lo = 0;
        let hi = merges.length - 1;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (check(merges[mid]))
                lo = mid + 1;
            else
                hi = mid;
        }
        first = lo;
    }
    if (first < 0) {
        return { checked: cache.size, message: `regress: command passes on the latest merge; no regression among ${merges.length} merge(s) after ${baseRef}.` };
    }
    const sha = merges[first];
    const parentRes = execGit(['rev-parse', `${sha}^1`], root);
    const parent = parentRes.ok ? parentRes.stdout.trim() : '';
    if (!parent || !check(parent)) {
        return { checked: cache.size, message: `regress: command fails at ${sha.slice(0, 12)} but its first parent already fails; no culprit merge identified.` };
    }
    const subject = execGit(['log', '-1', '--format=%s', sha], root).stdout.trim();
    return {
        culprit: { sha, subject },
        checked: cache.size,
        message: `regress: first failing merge is ${sha.slice(0, 12)} (${subject}).\nTo undo: git revert -m 1 ${sha}`,
    };
}
/** P9 `bastion audit --regress "<cmd>" [--base <ref>]`: prints the result; with a culprit prints `git revert -m 1 <sha>` and returns 1, else 0. */
export function runRegress(opts) {
    const r = findRegression(opts);
    console.log(r.message);
    return r.culprit ? 1 : 0;
}
