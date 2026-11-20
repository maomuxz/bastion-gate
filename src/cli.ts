#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { runAudit } from './commands/audit.js';
import { runCheck } from './commands/check.js';
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
import { runContract } from './commands/contract.js';
import { runFlow } from './commands/flow.js';
import { runGaps } from './commands/gaps.js';
import { runMap } from './commands/map.js';
import { runQa } from './commands/qa.js';
import { runReopen } from './commands/reopen.js';
import { runRegress } from './commands/regress.js';
import { runReview } from './commands/review.js';
import { runScaffold } from './commands/scaffold.js';
import { runSheet } from './commands/sheet.js';
import { runTests } from './commands/tests.js';
import { getRepoRoot } from './git.js';
import { parseTier } from './tier.js';
import { BASTION_VERSION } from './version.js';

const HELP = `bastion (bastion-gate) v${BASTION_VERSION}
Multi-agent parallel development & hard-gate CLI for AI coding agents.

Usage:
  bastion init [--test-cmd "<cmd>"] [--base <branch>] [--force]
  bastion sheet [--config <path>] [--out <path>] [--check]
  bastion check [--config <path>] [--base <ref>] [--lock] [--agent "<cmd>"] [--max-retries <0..2>] [--json] [files...]
  bastion lock [--base <ref>] [--amend --reason "<why>"] [--allow-dirty] [files...]
  bastion gate [--base <ref>]
  bastion plan [--init] [--force]
  bastion run [--base <ref>] [--agent "<cmd>"] [--setup "<cmd>"] [--concurrency <n>] [--max-retries <n>] [--verify-runs <n>] [--timeout <min>] [--max-calls <n>] [--max-minutes <n>] [--resume]
  bastion flow [--tier <village|city|capital>] ["<requirement>" | --requirement-file <path>]
                                          the whole flow (resumable). Tier is fixed at the start:
                                          village = thin contract, one session, no approval stop;
                                          city = one map, one block after another; capital = two maps, parallel (default)
  bastion contract "<requirement>"        village tier: one call writes the thin public interface as stubs
  bastion map "<requirement>" [--node <id>]   two independent planners draw the map; diff, interfaces, acceptance, plan
  bastion review [--approve]              one plain-language page to approve the map
  bastion scaffold                        create stub files with the agreed interfaces
  bastion tests [--lock] [--no-gaps]      tester writes red acceptance tests per node, gap check, then lock
  bastion gaps [--probe] [--drop "<file>::<case>"]  critic lists requirement rules no test checks (probe: hide one case)
  bastion qa [--ref <ref>]                black-box cases really run against the integrated code (or any ref)
  bastion summary                         three lines: done / decided for you / waiting for you
  bastion decisions                       tier-2 decisions agents made (what / why / how to undo)
  bastion answer <id> "<answer>"          answer a tier-3 question, then: bastion run --resume

Inside a node (agents, via node "$BASTION_CLI" ...):
  bastion decide --title "<t>" --chosen "<c>" --why "<w>" [--undo "<u>"] [--node <id>]
  bastion ask --question "<q>" [--recommend "<r>"] [--node <id>]
  bastion mutate [--max <n>] [--timeout <seconds>] [files...]
  bastion audit [--limit <n>] [--regress "<cmd>" [--base <ref>]]
  bastion clean [--yes] [--runs]
  bastion reopen <node> --reason "<why>" [--before <other>]   rebuild an already merged block (then: bastion run --resume)
  bastion --version
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

  if (subcommand === '--version' || subcommand === '-v' || subcommand === 'version') {
    console.log(BASTION_VERSION);
    return 0;
  }
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

      case 'sheet': {
        const { values } = parseArgs({
          args: rest,
          options: {
            config: { type: 'string' },
            out: { type: 'string' },
            check: { type: 'boolean', default: false },
          },
          allowPositionals: false,
        });
        return runSheet({
          cwd,
          configPath: values.config,
          outputPath: values.out,
          checkOnly: values.check,
        });
      }

      case 'check': {
        const { values, positionals } = parseArgs({
          args: rest,
          options: {
            config: { type: 'string' },
            base: { type: 'string' },
            lock: { type: 'boolean', default: false },
            agent: { type: 'string' },
            'max-retries': { type: 'string' },
            json: { type: 'boolean', default: false },
          },
          allowPositionals: true,
        });
        const parsedRetries =
          values['max-retries'] !== undefined
            ? (values['max-retries'].trim() === '' ? NaN : Number(values['max-retries']))
            : undefined;
        return await runCheck({
          cwd,
          configPath: values.config,
          baseRef: values.base,
          lock: values.lock,
          agentCommand: values.agent,
          maxRetries: parsedRetries,
          json: values.json,
          files: positionals,
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
        const { values, positionals } = parseArgs({ args: rest, options: { tier: { type: 'string' }, 'requirement-file': { type: 'string' } }, allowPositionals: true });
        let tier;
        if (values.tier !== undefined) {
          tier = parseTier(values.tier) ?? undefined;
          if (!tier) {
            console.error(`[bastion] flow: unknown tier "${values.tier}" (use village, city or capital).`);
            return 1;
          }
        }
        let flowRequirement = positionals.join(' ').trim() || undefined;
        if (values['requirement-file'] !== undefined) {
          // A long requirement (a whole spec) does not fit on a command line; read it from a file, verbatim.
          try {
            flowRequirement = fs.readFileSync(path.resolve(cwd, values['requirement-file']), 'utf8').replace(/^﻿/, '').trim() || undefined;
          } catch (e) {
            console.error(`[bastion] flow: cannot read --requirement-file: ${(e as Error).message}`);
            return 1;
          }
        }
        return await runFlow({ cwd, requirement: flowRequirement, tier });
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
          options: { lock: { type: 'boolean', default: false }, concurrency: { type: 'string' }, 'no-gaps': { type: 'boolean', default: false } },
          allowPositionals: false,
        });
        return await runTests({
          cwd, lock: values.lock, gaps: !values['no-gaps'],
          concurrency: values.concurrency ? Number(values.concurrency) : undefined,
        });
      }

      case 'gaps': {
        const { values } = parseArgs({
          args: rest,
          options: { probe: { type: 'boolean', default: false }, drop: { type: 'string' } },
          allowPositionals: false,
        });
        return await runGaps({ cwd, probe: values.probe || values.drop !== undefined, drop: values.drop });
      }

      case 'qa': {
        const { values } = parseArgs({ args: rest, options: { ref: { type: 'string' } }, allowPositionals: false });
        return await runQa({ cwd, ref: values.ref });
      }

      case 'reopen': {
        const { values, positionals } = parseArgs({
          args: rest,
          options: { reason: { type: 'string' }, before: { type: 'string' } },
          allowPositionals: true,
        });
        return runReopen({ cwd, node: positionals[0] ?? '', reason: values.reason ?? '', before: values.before });
      }

      case 'contract': {
        const { positionals } = parseArgs({ args: rest, options: {}, allowPositionals: true });
        return await runContract({ cwd, requirement: positionals.join(' ').trim() });
      }

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
        if (process.env.BASTION_QUESTIONS === 'off') {
          console.error('[bastion] ask: questions are switched off for this run (switch "questions"). Decide yourself and record the choice with the decisions file, or stop with a dispute.');
          return 1;
        }
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
            timeout: { type: 'string' },
          },
          allowPositionals: true,
        });
        let mutateTimeoutMs: number | undefined;
        if (values.timeout !== undefined) {
          const secs = Number(values.timeout);
          if (!Number.isFinite(secs) || secs <= 0) {
            console.error('[bastion] mutate: --timeout needs a positive number of seconds.');
            return 1;
          }
          mutateTimeoutMs = Math.round(secs * 1000);
        }
        return runMutate({
          cwd,
          files: positionals,
          maxMutations: values.max ? Number(values.max) : undefined,
          timeoutMs: mutateTimeoutMs,
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
