import * as fs from 'node:fs';
import * as path from 'node:path';
import { readFileAtRef, toPosixPath } from './git.js';
export const BASTION_DIR = '.bastion';
export const CONFIG_REL_PATH = '.bastion/config.json';
export const LOCK_REL_PATH = '.bastion/lock.json';
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
        lockedGlobs: overrides?.lockedGlobs ?? ['tests/**', 'test/**', '**/*.test.*', '**/*.spec.*', '**/*_test.*'],
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
    };
}
function parseLockJson(raw, label) {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.baseCommit !== 'string' || !Array.isArray(parsed.lockedFiles)) {
        throw new Error(`Invalid ${label}: missing baseCommit or lockedFiles.`);
    }
    return parsed;
}
