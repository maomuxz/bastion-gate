import { CONFIG_REL_PATH, LOCK_REL_PATH, readConfigFromDisk, readConfigFromRef, readLockFromRef, } from '../config.js';
import { getChangedFilesBetween, getDirtyFiles, getRepoRoot, resolveRef, } from '../git.js';
import { matchesAnyGlob, runTestCommand } from '../runner.js';
export function runGate(opts) {
    const repoRoot = getRepoRoot(opts.cwd);
    if (!repoRoot) {
        console.error('[bastion] Error: not inside a git repository.');
        return 1;
    }
    // Determine baseline ref (explicit --base > GITHUB_BASE_REF > config.baseBranch)
    let baseRef = opts.baseRef;
    if (!baseRef && process.env.GITHUB_BASE_REF) {
        baseRef = `origin/${process.env.GITHUB_BASE_REF}`;
    }
    if (!baseRef) {
        const diskConfig = readConfigFromDisk(repoRoot);
        baseRef = diskConfig.baseBranch;
    }
    const resolvedBase = resolveRef(baseRef, repoRoot);
    if (!resolvedBase) {
        console.error(`[bastion] GATE FAIL: cannot resolve baseline ref "${baseRef}".`);
        return 1;
    }
    // Read config & lock strictly from the BASELINE ref (never trust PR branch edits to config)
    const baseConfig = readConfigFromRef(resolvedBase, repoRoot);
    const baseLock = readLockFromRef(resolvedBase, repoRoot);
    const lockedSet = new Set(baseLock.lockedFiles.map((f) => f.path));
    const patterns = [...baseConfig.lockedGlobs, ...baseConfig.extraLockedPaths];
    const violations = [];
    // 1. Check committed changes between baseline ref and HEAD
    const changedCommits = getChangedFilesBetween(resolvedBase, 'HEAD', repoRoot);
    for (const rel of changedCommits) {
        if (rel === CONFIG_REL_PATH || rel === LOCK_REL_PATH) {
            violations.push(`Baseline bastion file modified in branch: ${rel}`);
        }
        else if (lockedSet.has(rel) || matchesAnyGlob(rel, patterns)) {
            violations.push(`Locked test/config file modified in branch: ${rel}`);
        }
    }
    // 2. Check uncommitted working tree changes
    const dirtyFiles = getDirtyFiles(repoRoot);
    for (const rel of dirtyFiles) {
        if (rel === CONFIG_REL_PATH || rel === LOCK_REL_PATH) {
            violations.push(`Uncommitted modification to bastion file: ${rel}`);
        }
        else if (lockedSet.has(rel) || matchesAnyGlob(rel, patterns)) {
            violations.push(`Uncommitted modification to locked file: ${rel}`);
        }
    }
    if (violations.length > 0) {
        console.error('[bastion] GATE FAIL: locked scope integrity violation(s):');
        for (const v of violations)
            console.error(`  - ${v}`);
        console.error('\nIf a locked test genuinely has a defect, a human must confirm and amend the lock on the baseline.');
        return 1;
    }
    // 3. Execute the baseline test command directly and inspect real exit code
    const cmdToRun = opts.testCommandOverride ?? baseConfig.testCommand;
    console.log(`[bastion] Integrity OK against ${baseRef} (${resolvedBase.slice(0, 8)}).`);
    console.log(`[bastion] Running baseline testCommand: ${cmdToRun}`);
    const run = runTestCommand(cmdToRun, repoRoot);
    if (run.stdout.trim())
        process.stdout.write(run.stdout + (run.stdout.endsWith('\n') ? '' : '\n'));
    if (run.stderr.trim())
        process.stderr.write(run.stderr + (run.stderr.endsWith('\n') ? '' : '\n'));
    if (run.exitCode !== 0) {
        console.error(`\n[bastion] GATE FAIL: testCommand exited with code ${run.exitCode} (${run.durationMs}ms).`);
        return 1;
    }
    console.log(`\n[bastion] GATE PASS: all checks passed in ${run.durationMs}ms.`);
    return 0;
}
