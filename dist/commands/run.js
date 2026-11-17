import { spawn } from 'node:child_process';
import { readConfigFromDisk, readPlanFromDisk, } from '../config.js';
import { execGit, getDirtyFiles, getRepoRoot, resolveRef } from '../git.js';
import { buildExecutionWaves } from '../orchestrator/dag.js';
import { createNodeWorktree, mergeNodeBranch, removeNodeWorktree, } from '../orchestrator/worktree.js';
import { runTestCommand } from '../runner.js';
import { runGate } from './gate.js';
function runAgentAsync(commandTemplate, node, worktreeDir, attempt, feedback) {
    return new Promise((resolve) => {
        const fullPrompt = feedback
            ? `${node.prompt}\n\n[Bastion Gate Feedback - Fix Required]\n${feedback}`
            : node.prompt;
        // Support {prompt}, {nodeId}, {worktree} placeholders, plus BASTION_* env vars
        const escapedPrompt = fullPrompt.replace(/"/g, '\\"');
        const cmd = commandTemplate
            .replace(/\{prompt\}/g, escapedPrompt)
            .replace(/\{nodeId\}/g, node.id)
            .replace(/\{worktree\}/g, worktreeDir);
        const env = {
            ...process.env,
            BASTION_NODE_ID: node.id,
            BASTION_NODE_TITLE: node.title,
            BASTION_PROMPT: fullPrompt,
            BASTION_WORKTREE: worktreeDir,
            BASTION_ATTEMPT: String(attempt),
            BASTION_FEEDBACK: feedback,
        };
        delete env.NODE_TEST_CONTEXT;
        const child = spawn(cmd, {
            cwd: worktreeDir,
            env,
            shell: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        child.stdout?.on('data', (d) => { output += String(d); });
        child.stderr?.on('data', (d) => { output += String(d); });
        child.on('close', (code) => {
            resolve({ exitCode: code ?? 1, output });
        });
    });
}
async function runWithConcurrency(items, limit, worker) {
    const results = new Array(items.length);
    let nextIdx = 0;
    async function next() {
        while (nextIdx < items.length) {
            const idx = nextIdx++;
            results[idx] = await worker(items[idx]);
        }
    }
    const workers = Array.from({ length: Math.min(limit, items.length) }, () => next());
    await Promise.all(workers);
    return results;
}
export async function runSwarm(opts) {
    const repoRoot = getRepoRoot(opts.cwd);
    if (!repoRoot) {
        console.error('[bastion] Error: not inside a git repository.');
        return 1;
    }
    const config = readConfigFromDisk(repoRoot);
    const plan = readPlanFromDisk(repoRoot);
    const waves = buildExecutionWaves(plan.nodes);
    // Enforce tier-3 human approval gate before spawning any workers
    const blockedTier3 = plan.nodes.filter((n) => n.tier === 3 && !n.approved);
    if (blockedTier3.length > 0) {
        console.error('[bastion] RUN BLOCKED: tier-3 node(s) require human approval ("approved": true):');
        for (const n of blockedTier3)
            console.error(`  - ${n.id}: ${n.title}`);
        return 1;
    }
    const agentCmd = opts.agentCommand ?? config.agentCommand;
    if (!agentCmd) {
        console.error('[bastion] Error: no agentCommand configured. Pass --agent "<cmd>" or set "agentCommand" in .bastion/config.json.');
        return 1;
    }
    const baseRef = opts.baseRef ?? config.baseBranch;
    if (!resolveRef(baseRef, repoRoot)) {
        console.error(`[bastion] Error: cannot resolve baseline ref "${baseRef}".`);
        return 1;
    }
    const dirty = getDirtyFiles(repoRoot);
    if (dirty.length > 0) {
        console.error('[bastion] Error: working tree is not clean. Commit or stash changes before `bastion run`.');
        return 1;
    }
    const concurrency = opts.concurrency ?? config.concurrency ?? 2;
    const maxRetries = opts.maxRetries ?? config.maxRetries ?? 2;
    const verifyRuns = opts.verifyRuns ?? config.verifyRuns ?? 1;
    console.log(`[bastion] Starting parallel swarm (${plan.nodes.length} nodes, ${waves.length} waves, concurrency=${concurrency}, maxRetries=${maxRetries})`);
    for (let w = 0; w < waves.length; w++) {
        const wave = waves[w];
        console.log(`\n=== Wave ${w + 1}/${waves.length}: [${wave.map((n) => n.id).join(', ')}] ===`);
        const currentHead = resolveRef('HEAD', repoRoot);
        const handles = wave.map((node) => createNodeWorktree(repoRoot, currentHead, node.id));
        try {
            const outcomes = await runWithConcurrency(wave.map((node, i) => ({ node, handle: handles[i] })), concurrency, async ({ node, handle }) => {
                let feedback = '';
                for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
                    console.log(`[${node.id}] Attempt ${attempt}/${maxRetries + 1} in ${handle.branch}...`);
                    const agentRes = await runAgentAsync(agentCmd, node, handle.dir, attempt, feedback);
                    if (agentRes.exitCode !== 0) {
                        feedback = `Agent command exited with ${agentRes.exitCode}.\n${agentRes.output.slice(-800)}`;
                        continue;
                    }
                    // Run hard gate inside the node's isolated worktree against baseline
                    const gateCode = runGate({
                        cwd: handle.dir,
                        baseRef,
                        testCommandOverride: node.testCommand,
                    });
                    if (gateCode === 0) {
                        // Commit any remaining clean worktree changes before merging
                        if (getDirtyFiles(handle.dir).length > 0) {
                            execGit(['add', '-A'], handle.dir);
                            execGit(['commit', '-m', `feat(${node.id}): ${node.title}`], handle.dir);
                        }
                        console.log(`[${node.id}] GATE PASS on attempt ${attempt}.`);
                        return { ok: true, node, handle };
                    }
                    feedback = `Bastion gate failed on attempt ${attempt}. Do not touch locked tests or .bastion/; fix the implementation to pass all locked tests.`;
                }
                return { ok: false, node, handle };
            });
            const failed = outcomes.filter((o) => !o.ok);
            if (failed.length > 0) {
                console.error(`\n[bastion] Wave ${w + 1} failed: ${failed.map((f) => f.node.id).join(', ')}`);
                return 1;
            }
            // Merge all gate-verified branches in deterministic order
            for (const { node, handle } of outcomes) {
                console.log(`[bastion] Merging ${handle.branch} -> HEAD...`);
                mergeNodeBranch(repoRoot, handle, node.title);
            }
        }
        finally {
            for (const handle of handles) {
                removeNodeWorktree(repoRoot, handle);
            }
        }
    }
    // Final full-suite verification N times
    console.log(`\n[bastion] All waves merged! Running final verification (${verifyRuns}x)...`);
    for (let i = 1; i <= verifyRuns; i++) {
        const res = runTestCommand(config.testCommand, repoRoot);
        if (res.exitCode !== 0) {
            console.error(`[bastion] Final verification ${i}/${verifyRuns} FAILED (exit ${res.exitCode}).`);
            return 1;
        }
        console.log(`[bastion] Final verification ${i}/${verifyRuns} PASS (${res.durationMs}ms).`);
    }
    console.log('\n[bastion] SWARM COMPLETE: all waves verified and merged cleanly.');
    return 0;
}
