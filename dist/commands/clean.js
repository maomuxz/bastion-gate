import * as fs from 'node:fs';
import * as path from 'node:path';
import { readConfigFromDisk } from '../config.js';
import { execGit, getRepoRoot } from '../git.js';
function isProcessAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
function removeDirWithRetry(dir, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            fs.rmSync(dir, { recursive: true, force: true });
            return;
        }
        catch (err) {
            if (i === retries - 1)
                throw err;
            const start = Date.now();
            while (Date.now() - start < 150) {
                // brief synchronous backoff for Windows file handle release
            }
        }
    }
}
/**
 * Clean leftover Bastion worktrees and temporary node branches (`bastion/<node>`).
 * Dry-run by default: requires `--yes` to actually delete. Preserves `bastion/run-*`
 * integration branches unless `--runs` is also passed (and only deletes merged ones).
 */
export function runClean(opts) {
    const repoRoot = getRepoRoot(opts.cwd);
    if (!repoRoot) {
        console.error('[bastion] Error: not inside a git repository.');
        return 1;
    }
    const pidFile = path.join(repoRoot, '.bastion', 'run.pid');
    if (fs.existsSync(pidFile)) {
        const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
        if (isProcessAlive(pid)) {
            console.error(`[bastion] Refusing to clean: active \`bastion run\` process (PID ${pid}) is still running.`);
            return 1;
        }
    }
    const dryRun = !opts.yes;
    const worktreesDir = path.join(repoRoot, '.bastion', 'worktrees');
    const worktreeEntries = fs.existsSync(worktreesDir) ? fs.readdirSync(worktreesDir) : [];
    const currentRes = execGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot);
    const currentBranch = currentRes.ok ? currentRes.stdout.trim() : '';
    let baseBranch = 'main';
    try {
        baseBranch = readConfigFromDisk(repoRoot).baseBranch;
    }
    catch {
        // fallback to main
    }
    const mergedRes = execGit(['branch', '--merged', baseBranch, '--list', 'bastion/*'], repoRoot);
    const mergedSet = new Set(mergedRes.ok
        ? mergedRes.stdout.split(/\r?\n/).map((l) => l.replace(/^\*?\s+/, '').trim()).filter(Boolean)
        : []);
    const branchRes = execGit(['branch', '--list', 'bastion/*'], repoRoot);
    const branches = branchRes.ok
        ? branchRes.stdout.split(/\r?\n/).map((l) => l.replace(/^\*?\s+/, '').trim()).filter(Boolean)
        : [];
    const toDeleteBranches = [];
    const preservedBranches = [];
    for (const b of branches) {
        if (b === currentBranch) {
            preservedBranches.push(`${b} (checked out)`);
            continue;
        }
        if (b.startsWith('bastion/run-')) {
            if (opts.runs && mergedSet.has(b)) {
                toDeleteBranches.push(b);
            }
            else {
                preservedBranches.push(opts.runs ? `${b} (unmerged into ${baseBranch} — kept safe)` : `${b} (integration branch)`);
            }
            continue;
        }
        toDeleteBranches.push(b);
    }
    const stateFile = path.join(repoRoot, '.bastion', 'run-state.json');
    const logsDir = path.join(repoRoot, '.bastion', 'logs');
    const hasState = fs.existsSync(stateFile);
    const hasLogs = fs.existsSync(logsDir);
    if (dryRun) {
        console.log('[bastion] Dry-run (pass --yes to delete):');
        if (worktreeEntries.length > 0)
            console.log(`  - Would remove .bastion/worktrees/ (${worktreeEntries.length} item(s))`);
        for (const b of toDeleteBranches)
            console.log(`  - Would delete branch: ${b}`);
        if (hasState)
            console.log('  - Would remove .bastion/run-state.json');
        if (hasLogs)
            console.log('  - Would remove .bastion/logs/');
        if (preservedBranches.length > 0) {
            console.log('  Preserved:');
            for (const b of preservedBranches)
                console.log(`    - ${b}`);
        }
        return 0;
    }
    if (fs.existsSync(worktreesDir)) {
        for (const entry of worktreeEntries) {
            const full = path.join(worktreesDir, entry);
            execGit(['worktree', 'remove', '--force', full], repoRoot);
            if (fs.existsSync(full))
                removeDirWithRetry(full);
        }
        removeDirWithRetry(worktreesDir);
        console.log('[bastion] Removed .bastion/worktrees/');
    }
    execGit(['worktree', 'prune'], repoRoot);
    for (const b of toDeleteBranches) {
        const del = execGit(['branch', '-D', b], repoRoot);
        if (del.ok)
            console.log(`[bastion] Deleted branch: ${b}`);
    }
    if (hasState) {
        fs.unlinkSync(stateFile);
        console.log('[bastion] Removed .bastion/run-state.json');
    }
    if (hasLogs) {
        removeDirWithRetry(logsDir);
        console.log('[bastion] Removed .bastion/logs/');
    }
    if (fs.existsSync(pidFile))
        fs.unlinkSync(pidFile);
    if (preservedBranches.length > 0) {
        console.log('[bastion] Preserved:');
        for (const b of preservedBranches)
            console.log(`  - ${b}`);
    }
    console.log('[bastion] Clean complete.');
    return 0;
}
