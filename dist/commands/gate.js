import { CONFIG_REL_PATH, LOCK_REL_PATH, PLAN_REL_PATH, readConfigFromDisk, readConfigFromRef, readLockFromRef, } from '../config.js';
import { getChangedFilesBetween, getDirtyFiles, getRepoRoot, resolveRef, } from '../git.js';
import { matchesAnyGlob, runTestCommand, runTestCommandAsync } from '../runner.js';
function checkGateIntegrity(opts) {
    const repoRoot = getRepoRoot(opts.cwd);
    if (!repoRoot) {
        const msg = '[bastion] Error: not inside a git repository.';
        console.error(msg);
        return { ok: false, feedback: msg };
    }
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
        const msg = `[bastion] GATE FAIL: cannot resolve baseline ref "${baseRef}".`;
        console.error(msg);
        return { ok: false, feedback: msg };
    }
    const baseConfig = readConfigFromRef(resolvedBase, repoRoot);
    const baseLock = readLockFromRef(resolvedBase, repoRoot);
    const lockedSet = new Set(baseLock.lockedFiles.map((f) => f.path));
    const patterns = [...baseConfig.lockedGlobs, ...baseConfig.extraLockedPaths];
    const violations = [];
    const changedCommits = getChangedFilesBetween(resolvedBase, 'HEAD', repoRoot);
    for (const rel of changedCommits) {
        if (rel === CONFIG_REL_PATH || rel === LOCK_REL_PATH || rel === PLAN_REL_PATH) {
            violations.push(`Baseline bastion file modified in branch: ${rel}`);
        }
        else if (lockedSet.has(rel) || matchesAnyGlob(rel, patterns)) {
            violations.push(`Locked test/config file modified in branch: ${rel}`);
        }
    }
    const dirtyFiles = getDirtyFiles(repoRoot);
    for (const rel of dirtyFiles) {
        if (rel === CONFIG_REL_PATH || rel === LOCK_REL_PATH || rel === PLAN_REL_PATH) {
            violations.push(`Uncommitted modification to bastion file: ${rel}`);
        }
        else if (lockedSet.has(rel) || matchesAnyGlob(rel, patterns)) {
            violations.push(`Uncommitted modification to locked file: ${rel}`);
        }
    }
    if (violations.length > 0) {
        const lines = [
            '[bastion] GATE FAIL: locked scope integrity violation(s):',
            ...violations.map((v) => `  - ${v}`),
            '',
            'If a locked test genuinely has a defect, a human must confirm and amend the lock on the baseline.',
        ];
        console.error(lines.join('\n'));
        return { ok: false, feedback: lines.join('\n') };
    }
    return {
        ok: true,
        repoRoot,
        baseRef,
        resolvedBase,
        cmdToRun: opts.testCommandOverride ?? baseConfig.testCommand,
    };
}
function tailLines(text, maxLines = 40) {
    const lines = text.trimEnd().split(/\r?\n/);
    return lines.slice(-maxLines).join('\n');
}
export function runGate(opts) {
    const check = checkGateIntegrity(opts);
    if (!check.ok)
        return 1;
    console.log(`[bastion] Integrity OK against ${check.baseRef} (${check.resolvedBase.slice(0, 8)}).`);
    console.log(`[bastion] Running baseline testCommand: ${check.cmdToRun}`);
    const run = runTestCommand(check.cmdToRun, check.repoRoot);
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
/** Async gate runner for parallel worktrees, returning detailed test failure output for retry feedback. */
export async function runGateAsync(opts) {
    const check = checkGateIntegrity(opts);
    if (!check.ok)
        return { exitCode: 1, feedback: check.feedback };
    console.log(`[bastion] Integrity OK against ${check.baseRef} (${check.resolvedBase.slice(0, 8)}).`);
    console.log(`[bastion] Running baseline testCommand: ${check.cmdToRun}`);
    const run = await runTestCommandAsync(check.cmdToRun, check.repoRoot);
    if (run.stdout.trim())
        process.stdout.write(run.stdout + (run.stdout.endsWith('\n') ? '' : '\n'));
    if (run.stderr.trim())
        process.stderr.write(run.stderr + (run.stderr.endsWith('\n') ? '' : '\n'));
    if (run.exitCode !== 0) {
        const combined = `${run.stdout}\n${run.stderr}`.trim();
        const feedback = `Test command "${check.cmdToRun}" failed (exit ${run.exitCode}):\n${tailLines(combined, 40)}`;
        console.error(`\n[bastion] GATE FAIL: testCommand exited with code ${run.exitCode} (${run.durationMs}ms).`);
        return { exitCode: 1, feedback };
    }
    console.log(`\n[bastion] GATE PASS: all checks passed in ${run.durationMs}ms.`);
    return { exitCode: 0, feedback: '' };
}
