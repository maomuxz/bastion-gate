#!/usr/bin/env node
// v1.1 tester sessions: one fresh Sonnet session per entry writes the listed test file(s), each in its own git worktree
// (node_modules linked), concurrency 4. Copies the written files back into the main checkout. Same method as v1.
// Usage (repo root): node docs/dogfood/v1.1/run-testers.mjs <round> [name ...]     e.g. round = r1
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repo = process.cwd();
const agent = path.join(repo, 'docs', 'dogfood', 'control', 'agent.mjs');
const usage = path.join(repo, '.bastion', 'logs', 'usage-testers.jsonl');
const wtRoot = path.join(repo, '.bastion', 'worktrees');

const ROUNDS = JSON.parse(fs.readFileSync(path.join(repo, 'docs', 'dogfood', 'v1.1', 'tester-nodes.json'), 'utf8'));
const [round, ...pick] = process.argv.slice(2);
const NODES = ROUNDS[round];
if (!NODES) { console.error(`unknown round ${round}; have ${Object.keys(ROUNDS).join(', ')}`); process.exit(1); }
const names = pick.length ? pick : Object.keys(NODES);

function prompt(name) {
  const n = NODES[name];
  const own = n.write.map((f) => `tests/${f}`).join(', ');
  const edit = (n.update ?? []).map((f) => `tests/${f}`).join(', ');
  return `You are the test writer for bastion-gate (TypeScript, ESM, node:test). Write: ${own}.
Contract to test: ${n.files}. Read them first; the doc comments are the spec (parts marked v1.1 are new). The v1.1 parts are still
stubs / old behaviour: your tests must COMPILE against the current signatures and FAIL on assertions (red) until someone
implements the contract.
Rules:
- node:test + node:assert/strict, import from '../src/...js'. Read tests/v1-qa.test.ts or tests/v1-tests-cmd.test.ts for style.
- Temp git repos only (createTempGitRepo, captureConsole, cleanupTempRepos in afterEach from tests/v04-helpers.ts). For any AI role use the
  fake role script in tests/v1-helpers.ts (createRoleRepo, setFixtures, readRoleCalls, sampleMap, SAMPLE_FILES); a role the config does not
  list (e.g. "critic") falls back to agentCommand, which is the same fake script, so a "critic" key in the fixtures works, including byLabel.
  Never call a real model or the network. Do not edit tests/v04-helpers.ts or tests/v1-helpers.ts.
- Cover every v1.1 rule in the doc comments with a concrete assertion, including edge cases a lazy implementation would get wrong.
  Prefer a few strong tests over many weak ones. Wrap calls that print in captureConsole. Keep each test under 30 s.
- Do not edit any file under src/. Do not commit.
${edit ? `- Existing tests that the new contract makes wrong: ${edit}. Update them minimally so they describe the new contract (keep every
  assertion that is still right). ${n.updateNote ?? ''}` : '- Do not edit any other test file.'}
- Verify: \`npm run build:test\` compiles with no errors in your files; then \`node --test ${n.write.map((f) => `dist-test/tests/${f.replace(/\.ts$/, '.js')}`).join(' ')}\`
  FAILS with assertion errors (not import/syntax errors). Put the pass/fail counts in your final reply.
${n.extra ?? ''}
`;
}

function sh(args, cwd) { return execFileSync('git', args, { cwd, encoding: 'utf8' }); }

async function runOne(name) {
  const n = NODES[name];
  const dir = path.join(wtRoot, `tester-${name}`);
  try { sh(['worktree', 'remove', '--force', dir], repo); } catch { /* none */ }
  sh(['worktree', 'add', '--detach', dir, 'HEAD'], repo);
  fs.symlinkSync(path.join(repo, 'node_modules'), path.join(dir, 'node_modules'), 'junction');
  const pf = path.join(repo, '.bastion', 'logs', `tester-${name}-prompt.txt`);
  fs.writeFileSync(pf, prompt(name), 'utf8');
  const log = fs.openSync(path.join(repo, '.bastion', 'logs', `tester-${name}.log`), 'w');
  const code = await new Promise((res) => {
    const c = spawn(process.execPath, [agent, pf, `tester-${name}`, usage], { cwd: dir, stdio: ['ignore', log, log] });
    c.on('close', res);
  });
  const report = [];
  for (const f of [...n.write, ...(n.update ?? [])]) {
    const src = path.join(dir, 'tests', f);
    if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(repo, 'tests', f)); report.push(`${f} copied`); } else report.push(`${f} MISSING`);
  }
  const stray = sh(['status', '--porcelain'], dir).split(/\r?\n/).filter((l) => l && !/node_modules/.test(l))
    .filter((l) => ![...n.write, ...(n.update ?? [])].some((f) => l.endsWith(`tests/${f}`)));
  fs.rmSync(path.join(dir, 'node_modules'), { force: true, recursive: false });
  try { sh(['worktree', 'remove', '--force', dir], repo); } catch { /* ignore */ }
  console.log(`${name}: agent exit ${code}; ${report.join('; ')}${stray.length ? `; STRAY EDITS: ${stray.join(' | ')}` : ''}`);
}

fs.mkdirSync(wtRoot, { recursive: true });
fs.mkdirSync(path.join(repo, '.bastion', 'logs'), { recursive: true });
const queue = [...names];
await Promise.all(Array.from({ length: 4 }, async () => {
  while (queue.length) await runOne(queue.shift());
}));
