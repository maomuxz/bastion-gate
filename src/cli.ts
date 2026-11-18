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
import { answerQuestion } from './inbox.js';
import { formatDecisions, readDecisions } from './ledger.js';
import { runAsk, runDecide } from './outbox.js';
import { summaryLines } from './summary.js';
import { runFlow } from './commands/flow.js';
import { runMap } from './commands/map.js';
import { runQa } from './commands/qa.js';
import { runRegress } from './commands/regress.js';
import { runReview } from './commands/review.js';
import { runScaffold } from './commands/scaffold.js';
import { runTests } from './commands/tests.js';
import { getRepoRoot } from './git.js';
import { BASTION_VERSION } from './version.js';

const HELP = `bastion (bastion-gate) v${BASTION_VERSION}
Multi-agent parallel development & hard-gate CLI for AI coding agents.

Usage:
  bastion init [--test-cmd "<cmd>"] [--base <branch>] [--force]
  bastion lock [--base <ref>] [--amend --reason "<why>"] [--allow-dirty] [files...]
  bastion gate [--base <ref>]
  bastion plan [--init] [--force]
  bastion run [--base <ref>] [--agent "<cmd>"] [--setup "<cmd>"] [--concurrency <n>] [--max-retries <n>] [--verify-runs <n>] [--timeout <min>] [--max-calls <n>] [--max-minutes <n>] [--resume]
  bastion flow ["<requirement>"]          the whole fortress: map -> review -> scaffold -> tests -> run -> qa (resumable)
  bastion map "<requirement>" [--node <id>]   two independent planners draw the map; diff, interfaces, acceptance, plan
  bastion review [--approve]              one plain-language page to approve the map
  bastion scaffold                        create stub files with the agreed interfaces
  bastion tests [--lock]                  tester writes red acceptance tests per node, then lock
  bastion qa                              acceptance review of the integration branch; reopens nodes on failure
  bastion summary                         three lines: done / decided for you / waiting for you
  bastion decisions                       tier-2 decisions agents made (what / why / how to undo)
  bastion answer <id> "<answer>"          answer a tier-3 question, then: bastion run --resume

Inside a node (agents, via node "$BASTION_CLI" ...):
  bastion decide --title "<t>" --chosen "<c>" --why "<w>" [--undo "<u>"] [--node <id>]
  bastion ask --question "<q>" [--recommend "<r>"] [--node <id>]
  bastion mutate [--max <n>] [files...]
  bastion audit [--limit <n>] [--regress "<cmd>" [--base <ref>]]
  bastion clean [--yes] [--runs]
  bastion --help
`;

function requireRepoRoot(cwd: string): string {
  const root = getRepoRoot(cwd);
  if (!root) throw new Error('not inside a git repository.');
  return root;
}

async function main(): Promise<number> {
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
            'max-calls': { type: 'string' },
            'max-minutes': { type: 'string' },
            single: { type: 'boolean', default: false },
            swarm: { type: 'boolean', default: false },
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
          maxCalls: values['max-calls'] ? Number(values['max-calls']) : undefined,
          maxMinutes: values['max-minutes'] ? Number(values['max-minutes']) : undefined,
          mode: values.single ? 'single' : values.swarm ? 'swarm' : undefined,
          resume: values.resume,
        });
      }

      case 'flow': {
        const { positionals } = parseArgs({ args: rest, options: {}, allowPositionals: true });
        return await runFlow({ cwd, requirement: positionals.join(' ').trim() || undefined });
      }

      case 'map': {
        const { values, positionals } = parseArgs({
          args: rest,
          options: { node: { type: 'string' }, timeout: { type: 'string' } },
          allowPositionals: true,
        });
        return await runMap({
          cwd,
          requirement: positionals.join(' ').trim() || undefined,
          parent: values.node,
          timeoutMinutes: values.timeout ? Number(values.timeout) : undefined,
        });
      }

      case 'review': {
        const { values } = parseArgs({ args: rest, options: { approve: { type: 'boolean', default: false } }, allowPositionals: false });
        return runReview({ cwd, approve: values.approve });
      }

      case 'scaffold':
        return await runScaffold({ cwd });

      case 'tests': {
        const { values } = parseArgs({
          args: rest,
          options: { lock: { type: 'boolean', default: false }, concurrency: { type: 'string' } },
          allowPositionals: false,
        });
        return await runTests({ cwd, lock: values.lock, concurrency: values.concurrency ? Number(values.concurrency) : undefined });
      }

      case 'qa':
        return await runQa({ cwd });

      case 'decide': {
        const { values } = parseArgs({
          args: rest,
          options: {
            title: { type: 'string' },
            chosen: { type: 'string' },
            why: { type: 'string' },
            undo: { type: 'string' },
            node: { type: 'string' },
          },
          allowPositionals: false,
        });
        return runDecide({ cwd, nodeId: values.node, title: values.title, chosen: values.chosen, why: values.why, undo: values.undo });
      }

      case 'ask': {
        const { values } = parseArgs({
          args: rest,
          options: {
            question: { type: 'string' },
            recommend: { type: 'string' },
            node: { type: 'string' },
          },
          allowPositionals: false,
        });
        return runAsk({ cwd, nodeId: values.node, question: values.question, recommend: values.recommend });
      }

      case 'decisions': {
        const repoRoot = requireRepoRoot(cwd);
        const lines = formatDecisions(readDecisions(repoRoot));
        console.log(lines.length > 0 ? lines.join('\n') : '[bastion] No decisions recorded.');
        return 0;
      }

      case 'answer': {
        const { positionals } = parseArgs({ args: rest, options: {}, allowPositionals: true });
        const [id, ...answerParts] = positionals;
        const answer = answerParts.join(' ').trim();
        if (!id || !answer) {
          console.error('[bastion] Usage: bastion answer <id> "<answer>"');
          return 1;
        }
        const item = answerQuestion(requireRepoRoot(cwd), id, answer);
        console.log(`[bastion] Answered ${item.id} (node ${item.node}). Continue with: bastion run --resume`);
        return 0;
      }

      case 'summary': {
        const lines = summaryLines(requireRepoRoot(cwd));
        if (lines.length === 0) {
          console.error('[bastion] summary: not implemented yet.');
          return 1;
        }
        console.log(lines.join('\n'));
        return 0;
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
            regress: { type: 'string' },
            base: { type: 'string' },
          },
          allowPositionals: false,
        });
        if (values.regress) return runRegress({ cwd, command: values.regress, base: values.base });
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
  } catch (err) {
    console.error(`[bastion] ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

main().then((code) => {
  process.exitCode = code;
});
