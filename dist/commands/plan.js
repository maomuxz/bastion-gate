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
function resolveEffectiveTestCommand(repoRoot, rawTestCommand) {
    const trimmed = rawTestCommand.trim();
    if (/^npm\s+test\b/.test(trimmed)) {
        const pkgPath = path.join(repoRoot, 'package.json');
        if (fs.existsSync(pkgPath)) {
            try {
                const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
                if (pkg.scripts?.test)
                    return pkg.scripts.test.trim();
            }
            catch {
                // ignore
            }
        }
    }
    return trimmed;
}
function deriveNodeTestCommand(repoRoot, globalTestCommand, testFile) {
    const effective = resolveEffectiveTestCommand(repoRoot, globalTestCommand);
    if (/\bvitest\b/.test(effective))
        return `npx vitest run ${testFile}`;
    if (/\bjest\b/.test(effective))
        return `npx jest ${testFile}`;
    if (/^node\s+--test\b/.test(effective))
        return `node --test ${testFile}`;
    if (/^(?:python\s+-m\s+)?pytest\b/.test(effective))
        return `pytest ${testFile}`;
    if (/^flutter\s+test\b/.test(effective))
        return `flutter test ${testFile}`;
    if (/^go\s+test\b/.test(effective)) {
        const dir = path.posix.dirname(testFile);
        return dir === '.' ? 'go test .' : `go test ./${dir}/`;
    }
    if (/^cargo\s+test\b/.test(effective) && testFile.startsWith('tests/')) {
        const stem = path.basename(testFile, path.extname(testFile));
        return `cargo test --test ${stem}`;
    }
    return undefined;
}
function isLikelyIntegrationTest(testFile) {
    const base = path.basename(testFile).toLowerCase();
    return /^(?:cli|main|app|e2e|integration)[._-]/.test(base);
}
function makeUniqueNodeId(testFile, used, index) {
    const clean = (s) => s.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
    const baseStem = path.basename(testFile).replace(/\.[^.]+$/, '');
    let id = clean(baseStem) || `node-${index + 1}`;
    if (used.has(id)) {
        const parent = path.posix.dirname(testFile);
        const parentClean = parent !== '.' ? clean(parent.replace(/\//g, '-')) : '';
        const candidate = parentClean ? `${parentClean}-${id}` : `${id}-${index + 1}`;
        id = used.has(candidate) ? `${candidate}-${index + 1}` : candidate;
    }
    used.add(id);
    return id;
}
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
    const usedIds = new Set();
    const unitNodes = [];
    const integrationSpecs = [];
    testFiles.forEach((file, idx) => {
        const id = makeUniqueNodeId(file, usedIds, idx);
        if (isLikelyIntegrationTest(file) && testFiles.length > 1) {
            integrationSpecs.push({ id, file });
            return;
        }
        const nodeCmd = deriveNodeTestCommand(repoRoot, config.testCommand, file);
        if (!nodeCmd) {
            console.log(`[bastion] Note: could not derive single-file command for "${file}"; node "${id}" will run the full testCommand.`);
        }
        unitNodes.push({
            id,
            title: `Pass ${file}`,
            prompt: `Implement the code required to pass ${file} without modifying locked tests or .bastion/.`,
            ...(nodeCmd ? { testCommand: nodeCmd } : {}),
            tier: 1,
        });
    });
    const unitIds = unitNodes.map((n) => n.id);
    const integrationNodes = integrationSpecs.map(({ id, file }) => ({
        id,
        title: `Integrate (${file})`,
        ...(unitIds.length > 0 ? { dependsOn: unitIds } : {}),
        prompt: `Integrate modules and verify ${file} passes without modifying locked tests or .bastion/.`,
        tier: 1,
    }));
    if (integrationNodes.length > 0) {
        console.log(`[bastion] Placed ${integrationNodes.map((n) => n.id).join(', ')} in Wave 2 (verify dependencies before running).`);
    }
    return { version: 1, nodes: [...unitNodes, ...integrationNodes] };
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
