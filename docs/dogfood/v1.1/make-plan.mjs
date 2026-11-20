#!/usr/bin/env node
// Builds .bastion/plan.json for one v1.1 round from docs/dogfood/v1.1/plan-nodes.json.
// Each node's test command = its own new/updated tests + every old test that is green at the baseline
// (old tests listed under "redUntil" are left out for every node except the one that turns them green).
// Usage (repo root): node docs/dogfood/v1.1/make-plan.mjs <round>
import * as fs from 'node:fs';
import * as path from 'node:path';

const repo = process.cwd();
const round = process.argv[2];
const spec = JSON.parse(fs.readFileSync(path.join(repo, 'docs', 'dogfood', 'v1.1', 'plan-nodes.json'), 'utf8'))[round];
if (!spec) { console.error(`unknown round ${round}`); process.exit(1); }

const owned = new Set(spec.nodes.flatMap((n) => n.tests));
const old = fs.readdirSync(path.join(repo, 'tests')).filter((f) => f.endsWith('.test.ts') && !owned.has(f)).sort();
const js = (f) => `dist-test/tests/${f.replace(/\.ts$/, '.js')}`;

const COMMON = 'Project: bastion-gate (TypeScript, Node 18+, zero runtime dependencies, ESM with .js import suffixes). ' +
  'Interfaces are frozen: keep every exported signature and the doc comments; implement the TODO / stub bodies and the paragraphs ' +
  'marked v1.1 exactly as the doc comments specify. Read your file(s), the shared types in src/commands/stages.ts, the helpers you may ' +
  'reuse (runRole and resolveAgentCommand in src/roles.ts, execGit in src/git.ts, src/orchestrator/worktree.ts, runTestCommand in ' +
  'src/runner.ts, readRunState/writeRunState) and the locked tests before coding.';

const nodes = spec.nodes.map((n) => {
  const tc = `npm run build && npm run build:test && node --test ${[...n.tests, ...old].map(js).join(' ')}`;
  return {
    id: n.id, title: n.title,
    prompt: `${COMMON}\n\n${n.task} Edit only ${n.files}. Acceptance: ${n.tests.map((t) => `tests/${t}`).join(', ')} (locked). ` +
      `All other tests in your test command must stay green.\n\nYour node test command: ${tc}`,
    testCommand: tc, tier: 1, ...(n.dependsOn?.length ? { dependsOn: n.dependsOn } : {}),
  };
});
fs.writeFileSync(path.join(repo, '.bastion', 'plan.json'), JSON.stringify({ version: 1, nodes }, null, 2) + '\n');
console.log(`${nodes.length} nodes; ${old.length} old test files in every command`);
