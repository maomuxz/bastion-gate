import * as fs from 'node:fs';
import * as path from 'node:path';
import { PLAN_REL_PATH, readPlanFromDisk, writePlanToDisk, } from '../config.js';
import { getRepoRoot } from '../git.js';
import { buildExecutionWaves } from '../orchestrator/dag.js';
const SAMPLE_PLAN = {
    version: 1,
    nodes: [
        {
            id: 'auth',
            title: 'Implement auth module',
            prompt: 'Implement src/auth to pass tests/auth.test without modifying locked tests.',
            tier: 1,
        },
        {
            id: 'billing',
            title: 'Implement billing module',
            prompt: 'Implement src/billing to pass tests/billing.test without modifying locked tests.',
            tier: 1,
        },
        {
            id: 'checkout',
            title: 'Wire auth + billing in checkout',
            dependsOn: ['auth', 'billing'],
            prompt: 'Integrate auth and billing in src/checkout to pass tests/checkout.test.',
            tier: 2,
        },
    ],
};
export function runPlan(opts) {
    const repoRoot = getRepoRoot(opts.cwd) ?? path.resolve(opts.cwd);
    const planPath = path.join(repoRoot, PLAN_REL_PATH);
    if (opts.init) {
        if (fs.existsSync(planPath) && !opts.force) {
            console.log(`[bastion] ${PLAN_REL_PATH} already exists (use --force to overwrite).`);
        }
        else {
            writePlanToDisk(repoRoot, SAMPLE_PLAN);
            console.log(`[bastion] Created ${PLAN_REL_PATH}`);
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
