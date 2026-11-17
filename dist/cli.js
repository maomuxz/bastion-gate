#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { runAudit } from './commands/audit.js';
import { runClean } from './commands/clean.js';
import { runGate } from './commands/gate.js';
import { runInit } from './commands/init.js';
import { runLock } from './commands/lock.js';
import { runMutate } from './commands/mutate.js';
import { runPlan } from './commands/plan.js';
import { runSwarm } from './commands/run.js';
import { BASTION_VERSION } from './version.js';
const HELP = `bastion (bastion-gate) v${BASTION_VERSION}
Multi-agent parallel development & hard-gate CLI for AI coding agents.

Usage:
  bastion init [--test-cmd "<cmd>"] [--base <branch>] [--force]
  bastion lock [--base <ref>] [--amend --reason "<why>"] [--allow-dirty] [files...]
  bastion gate [--base <ref>]
  bastion plan [--init] [--force]
  bastion run [--base <ref>] [--agent "<cmd>"] [--setup "<cmd>"] [--concurrency <n>] [--max-retries <n>] [--verify-runs <n>] [--timeout <min>] [--resume]
  bastion mutate [--max <n>] [files...]
  bastion audit [--limit <n>]
  bastion clean [--yes] [--runs]
  bastion --help
`;
async function main() {
    const argv = process.argv.slice(2);
    const subcommand = argv[0];
    if (!subcommand || subcommand === '--help' || subcommand === '-h') {
        console.log(HELP);
        return 0;
    }
    const rest = argv.slice(1);
    const cwd = process.cwd();
    try {
        switch (subcommand) {
            case 'init': {
                const { values } = parseArgs({
                    args: rest,
                    options: {
                        'test-cmd': { type: 'string' },
                        base: { type: 'string' },
                        force: { type: 'boolean', default: false },
                    },
                    allowPositionals: false,
                });
                return runInit({
                    cwd,
                    testCommand: values['test-cmd'],
                    baseBranch: values.base,
                    force: values.force,
                });
            }
            case 'lock': {
                const { values, positionals } = parseArgs({
                    args: rest,
                    options: {
                        base: { type: 'string' },
                        amend: { type: 'boolean', default: false },
                        reason: { type: 'string' },
                        'allow-dirty': { type: 'boolean', default: false },
                    },
                    allowPositionals: true,
                });
                return runLock({
                    cwd,
                    baseRef: values.base,
                    extraFiles: positionals,
                    amend: values.amend,
                    reason: values.reason,
                    allowDirty: values['allow-dirty'],
                });
            }
            case 'gate': {
                const { values } = parseArgs({
                    args: rest,
                    options: {
                        base: { type: 'string' },
                    },
                    allowPositionals: false,
                });
                return runGate({
                    cwd,
                    baseRef: values.base,
                });
            }
            case 'plan': {
                const { values } = parseArgs({
                    args: rest,
                    options: {
                        init: { type: 'boolean', default: false },
                        force: { type: 'boolean', default: false },
                    },
                    allowPositionals: false,
                });
                return runPlan({
                    cwd,
                    init: values.init,
                    force: values.force,
                });
            }
            case 'run': {
                const { values } = parseArgs({
                    args: rest,
                    options: {
                        base: { type: 'string' },
                        agent: { type: 'string' },
                        setup: { type: 'string' },
                        concurrency: { type: 'string' },
                        'max-retries': { type: 'string' },
                        'verify-runs': { type: 'string' },
                        timeout: { type: 'string' },
                        resume: { type: 'boolean', default: false },
                    },
                    allowPositionals: false,
                });
                return await runSwarm({
                    cwd,
                    baseRef: values.base,
                    agentCommand: values.agent,
                    setupCommand: values.setup,
                    concurrency: values.concurrency ? Number(values.concurrency) : undefined,
                    maxRetries: values['max-retries'] ? Number(values['max-retries']) : undefined,
                    verifyRuns: values['verify-runs'] ? Number(values['verify-runs']) : undefined,
                    timeoutMinutes: values.timeout ? Number(values.timeout) : undefined,
                    resume: values.resume,
                });
            }
            case 'mutate': {
                const { values, positionals } = parseArgs({
                    args: rest,
                    options: {
                        max: { type: 'string' },
                    },
                    allowPositionals: true,
                });
                return runMutate({
                    cwd,
                    files: positionals,
                    maxMutations: values.max ? Number(values.max) : undefined,
                });
            }
            case 'audit': {
                const { values } = parseArgs({
                    args: rest,
                    options: {
                        limit: { type: 'string' },
                    },
                    allowPositionals: false,
                });
                return runAudit({
                    cwd,
                    limit: values.limit ? Number(values.limit) : undefined,
                });
            }
            case 'clean': {
                const { values } = parseArgs({
                    args: rest,
                    options: {
                        yes: { type: 'boolean', default: false },
                        runs: { type: 'boolean', default: false },
                    },
                    allowPositionals: false,
                });
                return runClean({
                    cwd,
                    yes: values.yes,
                    runs: values.runs,
                });
            }
            default:
                console.error(`[bastion] Unknown command: ${subcommand}\n`);
                console.error(HELP);
                return 1;
        }
    }
    catch (err) {
        console.error(`[bastion] ${err instanceof Error ? err.message : String(err)}`);
        return 1;
    }
}
main().then((code) => {
    process.exitCode = code;
});
