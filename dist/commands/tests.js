import * as fs from 'node:fs';
import * as path from 'node:path';
import { LOCK_REL_PATH, readConfigFromDisk } from '../config.js';
import { execGit, getRepoRoot } from '../git.js';
import { INTERFACES_REL_PATH, readMap } from '../map.js';
import { resolveAgentCommand, runRole } from '../roles.js';
import { runLock } from './lock.js';
function buildPrompt(interfaces, node) {
    return [
        `You are the tester for node "${node.id}" (${node.title}).`,
        '',
        'Write the acceptance test file for this node. Write exactly one file and do not edit any other file.',
        `Test file to write: ${node.testFile}`,
        `Test command that will run it: ${node.testCommand}`,
        '',
        'The tests must exercise only the public interface below and must fail until the implementation is real.',
        'Every acceptance sentence must be covered by at least one test.',
        '',
        '## Shared interfaces (interfaces.md)',
        interfaces,
        '',
        `## Interface of node ${node.id}`,
        node.interface,
        '',
        `## Acceptance of node ${node.id}`,
        ...node.acceptance.map((a) => `- ${a}`),
        '',
        `Write the tests to ${node.testFile} now.`,
        '',
    ].join('\n');
}
/**
 * P4 `bastion tests [--lock]`: for every map node, call the tester role (up to `concurrency` at once, default 2) with
 * interfaces.md, the node's interface, acceptance and testFile; the tester must write exactly that test file.
 * A missing/empty test file -> 1. Commits the test files ("test(bastion): acceptance tests"). With lock: runs
 * runLock (amend with reason "bastion tests" when a lock already exists) and commits .bastion/lock.json; returns its result.
 */
export async function runTests(opts) {
    const repoRoot = getRepoRoot(opts.cwd);
    if (!repoRoot) {
        console.error('[bastion] Error: not inside a git repository.');
        return 1;
    }
    let config;
    try {
        config = readConfigFromDisk(repoRoot);
    }
    catch (e) {
        console.error(`[bastion] Error: ${e.message}`);
        return 1;
    }
    const map = readMap(repoRoot);
    if (!map) {
        console.error('[bastion] Error: .bastion/map.json is missing or unreadable. Run "bastion map" first.');
        return 1;
    }
    const command = resolveAgentCommand(config, 'tester');
    if (!command) {
        console.error('[bastion] Error: no tester command configured (roles.tester or agentCommand).');
        return 1;
    }
    const ifacePath = path.join(repoRoot, INTERFACES_REL_PATH);
    const interfaces = fs.existsSync(ifacePath) ? fs.readFileSync(ifacePath, 'utf8') : map.interfaces;
    const timeoutMs = opts.timeoutMinutes && opts.timeoutMinutes > 0 ? opts.timeoutMinutes * 60_000 : undefined;
    const limit = Math.max(1, Math.floor(opts.concurrency ?? 2));
    const nodes = map.nodes;
    const failed = new Set();
    let next = 0;
    const worker = async () => {
        while (next < nodes.length) {
            const node = nodes[next++];
            const res = await runRole(command, 'tester', {
                prompt: buildPrompt(interfaces, node),
                cwd: repoRoot,
                repoRoot,
                label: `tests-${node.id}`,
                timeoutMs,
            });
            const full = path.join(repoRoot, node.testFile);
            const written = fs.existsSync(full) && fs.statSync(full).isFile() && fs.statSync(full).size > 0;
            if (res.exitCode !== 0) {
                console.error(`[bastion] tests: tester for ${node.id} ${res.timedOut ? 'timed out' : `exited ${res.exitCode}`}.`);
                failed.add(node.id);
            }
            else if (!written) {
                console.error(`[bastion] tests: tester for ${node.id} did not write ${node.testFile} (missing or empty).`);
                failed.add(node.id);
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, nodes.length) }, () => worker()));
    if (failed.size > 0) {
        console.error(`[bastion] tests: failed for node(s): ${[...failed].join(', ')}.`);
        return 1;
    }
    const testFiles = [...new Set(nodes.map((n) => n.testFile.replace(/\\/g, '/')))];
    const commit = (files, message) => {
        const add = execGit(['add', '--', ...files], repoRoot);
        if (!add.ok) {
            console.error(`[bastion] tests: git add failed: ${add.stderr}`);
            return false;
        }
        const staged = execGit(['diff', '--cached', '--quiet', '--', ...files], repoRoot);
        if (staged.ok)
            return true; // nothing to commit
        const res = execGit(['commit', '-m', message, '--', ...files], repoRoot);
        if (!res.ok) {
            console.error(`[bastion] tests: git commit failed: ${res.stderr || res.stdout}`);
            return false;
        }
        return true;
    };
    if (!commit(testFiles, 'test(bastion): acceptance tests'))
        return 1;
    if (!opts.lock)
        return 0;
    const amend = fs.existsSync(path.join(repoRoot, LOCK_REL_PATH));
    const code = runLock(amend
        ? { cwd: repoRoot, amend: true, reason: 'bastion tests', extraFiles: testFiles }
        : { cwd: repoRoot, extraFiles: testFiles });
    if (code !== 0)
        return code;
    return commit([LOCK_REL_PATH], 'test(bastion): lock acceptance tests') ? 0 : 1;
}
