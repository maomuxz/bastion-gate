import * as fs from 'node:fs';
import * as path from 'node:path';
import { LOCK_REL_PATH, PLAN_REL_PATH, readConfigFromDisk, readLockFromDisk, readPlanFromDisk, writePlanToDisk, } from '../config.js';
import { getRepoRoot } from '../git.js';
import { buildExecutionWaves } from '../orchestrator/dag.js';
import { matchesAnyGlob } from '../runner.js';
const FALLBACK_PLAN = {
    version: 1,
    nodes: [
        {
            id: 'task-1',
            title: 'Implement module 1',
            prompt: 'Implement module 1 without modifying locked tests.',
            tier: 1,
        },
        {
            id: 'task-2',
            title: 'Implement module 2',
            prompt: 'Implement module 2 without modifying locked tests.',
            tier: 1,
        },
        {
            id: 'integrate',
            title: 'Integrate modules',
            dependsOn: ['task-1', 'task-2'],
            prompt: 'Wire module 1 and module 2 together and pass all tests.',
            tier: 2,
        },
    ],
};
function buildDraftPlanFromLock(repoRoot) {
    const lockPath = path.join(repoRoot, LOCK_REL_PATH);
    if (!fs.existsSync(lockPath))
        return null;
    const config = readConfigFromDisk(repoRoot);
    const lock = readLockFromDisk(repoRoot);
    const testFiles = lock.lockedFiles
        .map((f) => f.path)
        .filter((p) => matchesAnyGlob(p, config.lockedGlobs));
    if (testFiles.length === 0)
        return null;
    const nodes = testFiles.map((file, idx) => {
        const baseName = path.basename(file).replace(/\.[^.]+$/, '');
        const id = baseName.replace(/[^a-zA-Z0-9_-]+/g, '-').toLowerCase() || `node-${idx + 1}`;
        return {
            id,
            title: `Pass ${file}`,
            prompt: `Implement the code required to pass ${file} without modifying locked tests or .bastion/.`,
            tier: 1,
        };
    });
    return { version: 1, nodes };
}
export function runPlan(opts) {
    const repoRoot = getRepoRoot(opts.cwd) ?? path.resolve(opts.cwd);
    const planPath = path.join(repoRoot, PLAN_REL_PATH);
    if (opts.init) {
        if (fs.existsSync(planPath) && !opts.force) {
            console.log(`[bastion] ${PLAN_REL_PATH} already exists (use --force to overwrite).`);
        }
        else {
            const draft = buildDraftPlanFromLock(repoRoot) ?? FALLBACK_PLAN;
            writePlanToDisk(repoRoot, draft);
            console.log(`[bastion] Created ${PLAN_REL_PATH} (${draft.nodes.length} node(s)).`);
        }
        return 0;
    }
    const plan = readPlanFromDisk(repoRoot);
    const waves = buildExecutionWaves(plan.nodes);
    console.log(`[bastion] Execution plan (${plan.nodes.length} node(s), ${waves.length} wave(s)):`);
    waves.forEach((wave, idx) => {
        console.log(`\n  Wave ${idx + 1} (parallel):`);
        for (const node of wave) {
            const deps = node.dependsOn?.length ? ` [after: ${node.dependsOn.join(', ')}]` : '';
            const tier = node.tier ? ` (tier ${node.tier}${node.tier === 3 && !node.approved ? ' - NEEDS APPROVAL' : ''})` : '';
            console.log(`    - ${node.id}: ${node.title}${deps}${tier}`);
        }
    });
    const unapprovedTier3 = plan.nodes.filter((n) => n.tier === 3 && !n.approved);
    if (unapprovedTier3.length > 0) {
        console.error('\n[bastion] Warning: tier-3 nodes require "approved": true before `bastion run` will execute them.');
        return 1;
    }
    return 0;
}
