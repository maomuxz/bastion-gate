import * as fs from 'node:fs';
import * as path from 'node:path';
import { CONFIG_REL_PATH, LOCK_REL_PATH, readConfigFromDisk, readLockFromDisk, writeLockToDisk, } from '../config.js';
import { execGit, getDirtyFiles, getRepoRoot, resolveRef } from '../git.js';
import { matchesAnyGlob, runTestCommand, sha256File, walkRepoFiles } from '../runner.js';
import { extractTestNames } from '../test-names.js';
const FAKE_RED_PATTERN = /(?:SyntaxError:|IndentationError:|ImportError:|ModuleNotFoundError:|ERR_MODULE_NOT_FOUND|Cannot find module ['"]|Cannot find package ['"])/;
export function runLock(opts) {
    const repoRoot = getRepoRoot(opts.cwd);
    if (!repoRoot) {
        console.error('[bastion] Error: not inside a git repository.');
        return 1;
    }
    const config = readConfigFromDisk(repoRoot);
    const baseRef = opts.baseRef ?? 'HEAD';
    const baseCommit = resolveRef(baseRef, repoRoot);
    if (!baseCommit) {
        console.error(`[bastion] Error: cannot resolve baseline ref "${baseRef}". Commit your baseline first.`);
        return 1;
    }
    // Check if amending an existing lock
    let existingLock = null;
    if (fs.existsSync(path.join(repoRoot, LOCK_REL_PATH))) {
        existingLock = readLockFromDisk(repoRoot);
        if (!opts.amend) {
            console.error(`[bastion] Error: ${LOCK_REL_PATH} already exists.`);
            console.error('  Modifying a lock is a human-confirmed test_defect action.');
            console.error('  If the test itself is defective, run: bastion lock --amend --reason "<why>"');
            return 1;
        }
        if (!opts.reason || !opts.reason.trim()) {
            console.error('[bastion] Error: --amend requires a non-empty --reason "<why>".');
            return 1;
        }
    }
    // Collect all files matching lockedGlobs, extraLockedPaths, and explicit CLI args
    const allRepoFiles = walkRepoFiles(repoRoot);
    const explicitFiles = (opts.extraFiles ?? []).map((f) => f.replace(/\\/g, '/').replace(/^\.\//, ''));
    const patterns = [...config.lockedGlobs, ...config.extraLockedPaths];
    const lockedSet = new Set();
    for (const rel of allRepoFiles) {
        if (matchesAnyGlob(rel, patterns) || explicitFiles.includes(rel)) {
            lockedSet.add(rel);
        }
    }
    for (const rel of explicitFiles) {
        if (!fs.existsSync(path.join(repoRoot, rel))) {
            console.error(`[bastion] Error: specified file does not exist: ${rel}`);
            return 1;
        }
        lockedSet.add(rel);
    }
    const lockedPaths = [...lockedSet].sort();
    if (lockedPaths.length === 0) {
        console.error('[bastion] Error: no test or config files matched lockedGlobs / extraLockedPaths.');
        return 1;
    }
    // Ensure config and locked files are committed cleanly to baseline (unless --allow-dirty)
    if (!opts.allowDirty) {
        const dirty = new Set(getDirtyFiles(repoRoot));
        const dirtyLocked = [CONFIG_REL_PATH, ...lockedPaths].filter((f) => dirty.has(f));
        if (dirtyLocked.length > 0) {
            console.error('[bastion] Error: locked files or config have uncommitted changes:');
            for (const f of dirtyLocked)
                console.error(`  - ${f}`);
            console.error('  Commit them to the baseline branch first so "gate" can verify against git history.');
            return 1;
        }
    }
    // RED-FIRST VERIFICATION: tests MUST FAIL on the baseline before locking
    console.log(`[bastion] Running red-first check: ${config.testCommand}`);
    let run = runTestCommand(config.testCommand, repoRoot);
    let redVerifiedAgainst;
    if (run.exitCode === 0 && opts.amend && existingLock) {
        const prev = existingLock.baseCommit;
        console.log(`[bastion] Suite is green on HEAD; verifying red-first against previous baseline ${prev.slice(0, 8)}...`);
        const wtDir = path.join(repoRoot, '.bastion', 'worktrees', `amend-check-${process.pid}-${Date.now()}`);
        let prevRun = null;
        let failure = null;
        try {
            fs.mkdirSync(path.dirname(wtDir), { recursive: true });
            const add = execGit(['worktree', 'add', '--detach', wtDir, prev], repoRoot);
            if (add.status !== 0) {
                failure = `cannot create temporary worktree at ${prev.slice(0, 8)}: ${add.stderr.trim()}`;
            }
            else {
                for (const rel of lockedPaths.filter((p) => matchesAnyGlob(p, config.lockedGlobs))) {
                    const dest = path.join(wtDir, rel);
                    fs.mkdirSync(path.dirname(dest), { recursive: true });
                    fs.copyFileSync(path.join(repoRoot, rel), dest);
                }
                if (config.setupCommand) {
                    const setup = runTestCommand(config.setupCommand, wtDir);
                    if (setup.exitCode !== 0)
                        failure = `setupCommand failed in the baseline worktree (exit ${setup.exitCode}).`;
                }
                if (!failure)
                    prevRun = runTestCommand(config.testCommand, wtDir);
            }
        }
        finally {
            execGit(['worktree', 'remove', '--force', wtDir], repoRoot);
            if (fs.existsSync(wtDir))
                fs.rmSync(wtDir, { recursive: true, force: true });
            execGit(['worktree', 'prune'], repoRoot);
        }
        if (failure || !prevRun) {
            console.error(`\n[REJECTED] Amend red-first check could not run: ${failure}`);
            return 1;
        }
        if (prevRun.exitCode === 0) {
            console.error('\n[REJECTED] Amended tests also PASS on the previous baseline: they do not strengthen anything (tautology).');
            return 1;
        }
        if (!opts.allowImportError && FAKE_RED_PATTERN.test(`${prevRun.stdout}\n${prevRun.stderr}`)) {
            console.error('\n[REJECTED] Fake-red detected on the previous baseline: failure is a SyntaxError or missing module/import, not a failing assertion!');
            return 1;
        }
        run = prevRun;
        redVerifiedAgainst = prev;
    }
    if (run.exitCode === 0) {
        console.error('\n[REJECTED] Red-first check failed: tests PASSED (exit 0) on the baseline!');
        console.error('  A test that already passes before implementation is either a tautology or not testing new work.');
        console.error('  Bastion refuses to lock green tests. Write a failing test first, then run "bastion lock".');
        return 1;
    }
    const combinedOutput = `${run.stdout}\n${run.stderr}`;
    if (!opts.allowImportError && FAKE_RED_PATTERN.test(combinedOutput)) {
        console.error('\n[REJECTED] Fake-red detected: tests failed due to SyntaxError or missing module/import, not a failing assertion!');
        console.error('  Create stub exports/signatures first so the test fails on an assertion, then run "bastion lock".');
        return 1;
    }
    console.log(`[bastion] Red-first verified (exit ${run.exitCode} in ${run.durationMs}ms). Locking ${lockedPaths.length} file(s)...`);
    const lockedFiles = lockedPaths.map((rel) => ({
        path: rel,
        sha256: sha256File(path.join(repoRoot, rel)),
    }));
    const testSummary = lockedPaths
        .filter((rel) => matchesAnyGlob(rel, config.lockedGlobs))
        .map((rel) => {
        const content = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
        return { file: rel, names: extractTestNames(content) };
    })
        .filter((entry) => entry.names.length > 0);
    const amendments = existingLock?.amendments ? [...existingLock.amendments] : [];
    if (existingLock && opts.amend && opts.reason) {
        amendments.push({
            at: new Date().toISOString(),
            reason: opts.reason.trim(),
            previousBaseCommit: existingLock.baseCommit,
            newBaseCommit: baseCommit,
            ...(redVerifiedAgainst ? { redVerifiedAgainst } : {}),
        });
    }
    const lock = {
        version: 1,
        lockedAt: new Date().toISOString(),
        baseCommit,
        testCommand: config.testCommand,
        redVerified: {
            exitCode: run.exitCode,
            command: config.testCommand,
        },
        lockedFiles,
        testSummary,
        ...(amendments.length > 0 ? { amendments } : {}),
    };
    writeLockToDisk(repoRoot, lock);
    console.log(`[bastion] Wrote ${LOCK_REL_PATH} (baseCommit: ${baseCommit.slice(0, 8)}).`);
    if (testSummary.length > 0) {
        console.log('\nLocked test cases (plain-language scan):');
        for (const entry of testSummary) {
            console.log(`  ${entry.file}:`);
            for (const name of entry.names) {
                console.log(`    - ${name}`);
            }
        }
    }
    const acceptancePath = path.join(repoRoot, '.bastion', 'acceptance.md');
    if (fs.existsSync(acceptancePath)) {
        const accLines = fs
            .readFileSync(acceptancePath, 'utf8')
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => /^[-*\d.]+\s+/.test(l));
        if (accLines.length > 0) {
            const totalTests = testSummary.reduce((acc, s) => acc + s.names.length, 0);
            console.log(`\nAcceptance checklist (.bastion/acceptance.md: ${accLines.length} item(s) vs ${totalTests} locked test(s)):`);
            for (const item of accLines)
                console.log(`  ${item}`);
        }
    }
    console.log('\nRemember: commit .bastion/lock.json to your baseline branch before agents start coding.');
    return 0;
}
