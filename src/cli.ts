#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { runAudit } from './commands/audit.js';
import { runGate } from './commands/gate.js';
import { runInit } from './commands/init.js';
import { runLock } from './commands/lock.js';

const HELP = `bastion (bastion-gate) v0.1.0
Test-locking & hard-gate CLI for AI coding agents.

Usage:
  bastion init [--test-cmd "<cmd>"] [--base <branch>] [--force]
  bastion lock [--base <ref>] [--amend --reason "<why>"] [--allow-dirty] [files...]
  bastion gate [--base <ref>]
  bastion audit [--limit <n>]
  bastion --help
`;

function main(): number {
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

process.exitCode = main();
