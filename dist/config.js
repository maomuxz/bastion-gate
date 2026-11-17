import * as fs from 'node:fs';
import * as path from 'node:path';
import { readFileAtRef, toPosixPath } from './git.js';
export const BASTION_DIR = '.bastion';
export const CONFIG_REL_PATH = '.bastion/config.json';
export const LOCK_REL_PATH = '.bastion/lock.json';
export const PLAN_REL_PATH = '.bastion/plan.json';
export const DEFAULT_EXTRA_LOCKED_PATHS = [
    'package.json',
    'package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'pyproject.toml',
    'pytest.ini',
    'setup.cfg',
    'tox.ini',
    'vitest.config.*',
    'jest.config.*',
    'tsconfig.json',
    '**/conftest.py',
    '**/fixtures/**',
    '**/__snapshots__/**',
];
export function createDefaultConfig(overrides) {
    return {
        version: 1,
        testCommand: overrides?.testCommand ?? 'npm test',
        baseBranch: overrides?.baseBranch ?? 'main',
        lockedGlobs: overrides?.lockedGlobs ?? ['tests/**', 'test/**', '**/*.test.*', '**/*.spec.*', '**/*_test.*', '**/test_*.*'],
        extraLockedPaths: overrides?.extraLockedPaths ?? DEFAULT_EXTRA_LOCKED_PATHS,
    };
}
export function readConfigFromDisk(repoRoot) {
    const fullPath = path.join(repoRoot, CONFIG_REL_PATH);
    if (!fs.existsSync(fullPath)) {
        throw new Error(`Missing ${CONFIG_REL_PATH}. Run "bastion init" first.`);
    }
    return parseConfigJson(fs.readFileSync(fullPath, 'utf8'), CONFIG_REL_PATH);
}
export function readConfigFromRef(ref, repoRoot) {
    const raw = readFileAtRef(ref, CONFIG_REL_PATH, repoRoot);
    if (raw === null) {
        throw new Error(`Missing ${CONFIG_REL_PATH} on baseline ref "${ref}". Commit it to the baseline branch first.`);
    }
    return parseConfigJson(raw, `${ref}:${CONFIG_REL_PATH}`);
}
export function readLockFromDisk(repoRoot) {
    const fullPath = path.join(repoRoot, LOCK_REL_PATH);
    if (!fs.existsSync(fullPath)) {
        throw new Error(`Missing ${LOCK_REL_PATH}. Run "bastion lock" first.`);
    }
    return parseLockJson(fs.readFileSync(fullPath, 'utf8'), LOCK_REL_PATH);
}
export function readLockFromRef(ref, repoRoot) {
    const raw = readFileAtRef(ref, LOCK_REL_PATH, repoRoot);
    if (raw === null) {
        throw new Error(`Missing ${LOCK_REL_PATH} on baseline ref "${ref}". Commit the lock file on the baseline branch first.`);
    }
    return parseLockJson(raw, `${ref}:${LOCK_REL_PATH}`);
}
export function writeConfigToDisk(repoRoot, config) {
    const dir = path.join(repoRoot, BASTION_DIR);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(repoRoot, CONFIG_REL_PATH), JSON.stringify(config, null, 2) + '\n', 'utf8');
}
export function writeLockToDisk(repoRoot, lock) {
    const dir = path.join(repoRoot, BASTION_DIR);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(repoRoot, LOCK_REL_PATH), JSON.stringify(lock, null, 2) + '\n', 'utf8');
}
function parseConfigJson(raw, label) {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.testCommand !== 'string' || !parsed.testCommand.trim()) {
        throw new Error(`Invalid ${label}: "testCommand" must be a non-empty string.`);
    }
    return {
        version: 1,
        testCommand: parsed.testCommand.trim(),
        baseBranch: typeof parsed.baseBranch === 'string' && parsed.baseBranch.trim() ? parsed.baseBranch.trim() : 'main',
        lockedGlobs: Array.isArray(parsed.lockedGlobs) ? parsed.lockedGlobs.map(toPosixPath) : [],
        extraLockedPaths: Array.isArray(parsed.extraLockedPaths) ? parsed.extraLockedPaths.map(toPosixPath) : [],
        ...(typeof parsed.setupCommand === 'string' && parsed.setupCommand.trim()
            ? { setupCommand: parsed.setupCommand.trim() }
            : {}),
        ...(typeof parsed.agentCommand === 'string' && parsed.agentCommand.trim()
            ? { agentCommand: parsed.agentCommand.trim() }
            : {}),
        ...(typeof parsed.concurrency === 'number' && parsed.concurrency > 0
            ? { concurrency: Math.floor(parsed.concurrency) }
            : {}),
        ...(typeof parsed.maxRetries === 'number' && parsed.maxRetries >= 0
            ? { maxRetries: Math.floor(parsed.maxRetries) }
            : {}),
        ...(typeof parsed.verifyRuns === 'number' && parsed.verifyRuns > 0
            ? { verifyRuns: Math.floor(parsed.verifyRuns) }
            : {}),
        ...(typeof parsed.timeoutMinutes === 'number' && parsed.timeoutMinutes > 0
            ? { timeoutMinutes: parsed.timeoutMinutes }
            : {}),
    };
}
export function readPlanFromDisk(repoRoot) {
    const fullPath = path.join(repoRoot, PLAN_REL_PATH);
    if (!fs.existsSync(fullPath)) {
        throw new Error(`Missing ${PLAN_REL_PATH}. Run "bastion plan --init" first.`);
    }
    const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    if (!parsed || !Array.isArray(parsed.nodes) || parsed.nodes.length === 0) {
        throw new Error(`Invalid ${PLAN_REL_PATH}: "nodes" must be a non-empty array.`);
    }
    return { version: 1, nodes: parsed.nodes };
}
export function writePlanToDisk(repoRoot, plan) {
    const dir = path.join(repoRoot, BASTION_DIR);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(repoRoot, PLAN_REL_PATH), JSON.stringify(plan, null, 2) + '\n', 'utf8');
}
function parseLockJson(raw, label) {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.baseCommit !== 'string' || !Array.isArray(parsed.lockedFiles)) {
        throw new Error(`Invalid ${label}: missing baseCommit or lockedFiles.`);
    }
    return parsed;
}
