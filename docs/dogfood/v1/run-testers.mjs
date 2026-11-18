#!/usr/bin/env node
// Manual rehearsal of the tester role: one fresh Sonnet session per node writes one test file, each in its own
// git worktree (node_modules linked), concurrency 4. Copies the written test files back into the main checkout.
// Usage (repo root): node docs/dogfood/v1/run-testers.mjs [name ...]
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repo = process.cwd();
const agent = path.join(repo, 'docs', 'dogfood', 'control', 'agent.mjs');
const usage = path.join(repo, '.bastion', 'logs', 'usage-testers.jsonl');
const wtRoot = path.join(repo, '.bastion', 'worktrees');

const NODES = {
  'map-core': { files: 'src/map.ts', extra: '' },
  'split': { files: 'src/split.ts (and the BastionMap types in src/map.ts)', extra: 'Build small BastionMap literals by hand (sampleMap() is a convenient start).' },
  'single': { files: 'src/single.ts', extra: 'Also test the integration already wired in src/commands/run.ts: with config runMode "single" (configPatch in createSwarmRepo from tests/v04-helpers.ts) and two nodes, runSwarm calls the agent exactly once (count files in .bastion/logs/*-attempt-*.log) and marks both nodes completed; with runMode unset it still runs one agent call per node.' },
  'slots': { files: 'src/slots.ts', extra: 'Use deferred promises to observe concurrency precisely (no timing sleeps longer than ~50 ms).' },
  'map-cmd': { files: 'src/commands/map.ts, src/commands/stages.ts, src/map.ts, src/split.ts, runRole in src/roles.ts', extra: 'Planner and blind outputs come from role fixtures (output: a map). Check both roles were called, that the blind prompt does not contain the planner map, all output files, plan.json, approval removal, invalid planner map -> 1 with nothing written, invalid blind map -> still 0 with the diff mentioning it, and --node splitting.' },
  'review': { files: 'src/commands/review.ts, src/commands/stages.ts', extra: 'Write .bastion/map.json yourself (sampleMap()) instead of calling bastion map.' },
  'scaffold': { files: 'src/commands/scaffold.ts, src/commands/stages.ts', extra: 'Use createRoleRepo with a committed .bastion/map.json (sampleMap()) and a worker fixture that writes SAMPLE_FILES.stubs.' },
  'tests-cmd': { files: 'src/commands/tests.ts, src/commands/stages.ts', extra: 'Use createRoleRepo with committed map.json, stubs and a tester fixture whose byLabel entries write the right test file per node (inspect readRoleCalls labels to learn them, or give the same files to every call). Check the lock flow produces a committed .bastion/lock.json.' },
  'qa': { files: 'src/commands/qa.ts, src/commands/stages.ts', extra: 'Set up a real completed run first (createSwarmRepo-like or createRoleRepo + plan + runSwarm). Also test the wiring already in src/commands/run.ts: after a failing QA reopens a node, `runSwarm({resume:true})` gives that node a prompt (.bastion/logs/<id>-prompt.txt) containing the QA issue, and the feedback file is removed after it passes.' },
  'flow': { files: 'src/commands/flow.ts, src/commands/stages.ts (and the commands it chains)', extra: 'One end-to-end test with createRoleRepo, sampleMap and SAMPLE_FILES: planner/blind output the map, worker (scaffold) writes stubs, tester writes the tests, "run" byLabel n1/n2 write the implementations, qa outputs {verdict:"pass",findings:[]}. Expect: first runFlow({requirement}) -> 2; second runFlow -> 2 (not approved); runReview({approve:true}); third runFlow -> 0 with both nodes completed. Also a resume test: re-running flow after done returns 0 without new role calls.' },
  'audit-amend': { files: 'isAuthorizedAmendment and its use in runAudit, src/commands/audit.ts', extra: 'Build repos where a --no-ff merge brings in (a) a properly amended lock (run runLock with amend:true on the branch after editing a test) -> runAudit 0 and the merge is reported as an authorised amendment; (b) a test edit without a lock amendment -> 1; (c) an amended lock whose recorded sha256 does not match the merged test content -> 1; (d) a merge touching .bastion/config.json -> 1. Unit-test isAuthorizedAmendment directly too.' },
  'map-details': { files: 'diffMapDetails in src/map.ts and how src/commands/map.ts appends it to map-diff.md', extra: 'Unit-test diffMapDetails (whitespace-only interface changes are NOT differences; acceptance compared as sets; order follows map A; nodes only in one map are ignored). Then one runMap test with role fixtures where planner and blind maps differ only in one interface: map-diff.md has an "## Interfaces and acceptance" section and no "No differences." line; identical maps still give "No differences.".' },
  'dirty': { files: 'src/dirty.ts and its use in runSwarm (src/commands/run.ts)', extra: 'Unit-test blockingDirtyFiles in temp repos (untracked scratch file ignored; untracked file under tests/ blocks; modified tracked file blocks; untracked .bastion/map.json blocks; gitignored file ignored). Then runSwarm on a createSwarmRepo fixture with an extra untracked notes.txt returns 0, and with a modified tracked file returns 1.' },
  'mutate-comments': { files: 'codeLineMask and its use in collecting mutants, src/commands/mutate.ts', extra: 'Unit-test codeLineMask on JSDoc blocks, single-line /* */, code followed by an opening block comment, // and # comments, import lines and blank lines. Then runMutate on a temp repo whose source has `===` only inside a JSDoc comment plus one real `===` in code: only the code line is mutated (inspect the printed mutant lines).' },
  'regress': { files: 'src/commands/regress.ts, src/commands/stages.ts', extra: 'Build a repo with three --no-ff merges where the second merge breaks a check command (e.g. node check.mjs), and one repo with no breaking merge.' },
};

const pick = process.argv.slice(2);
const names = pick.length ? pick : Object.keys(NODES);

function prompt(name) {
  const n = NODES[name];
  return `You are the test writer for bastion-gate (TypeScript, ESM, node:test). Write ONE file: tests/v1-${name}.test.ts.
Contract to test: ${n.files}. Read them first; the doc comments are the spec. The implementation is still a stub: your tests must
COMPILE against the current signatures and FAIL on assertions (red) until someone implements the contract.
Rules:
- node:test + node:assert/strict, import from '../src/...js'. Read tests/v041-progress.test.ts for style.
- Temp git repos only (createTempGitRepo, captureConsole, cleanupTempRepos in afterEach from tests/v04-helpers.ts). For any AI role use the
  fake role script in tests/v1-helpers.ts (createRoleRepo, setFixtures, readRoleCalls, sampleMap, SAMPLE_FILES). Never call a real model or the network.
- Cover every rule in the doc comments with a concrete assertion, including edge cases a lazy implementation would get wrong.
  Prefer a few strong tests over many weak ones. Wrap calls that print in captureConsole. Keep each test under 30 s.
- Do not edit any other file. Do not commit.
- Verify: \`npm run build:test\` compiles with no errors in your file; then \`node --test dist-test/tests/v1-${name}.test.js\` FAILS with
  assertion errors (not import/syntax errors). Put the pass/fail counts in your final reply.
${n.extra}
`;
}

function sh(args, cwd) { return execFileSync('git', args, { cwd, encoding: 'utf8' }); }

async function runOne(name) {
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
  const src = path.join(dir, 'tests', `v1-${name}.test.ts`);
  const ok = fs.existsSync(src);
  if (ok) fs.copyFileSync(src, path.join(repo, 'tests', `v1-${name}.test.ts`));
  fs.rmSync(path.join(dir, 'node_modules'), { force: true, recursive: false });
  try { sh(['worktree', 'remove', '--force', dir], repo); } catch { /* ignore */ }
  console.log(`${name}: agent exit ${code}, test file ${ok ? 'copied' : 'MISSING'}`);
}

fs.mkdirSync(wtRoot, { recursive: true });
const queue = [...names];
await Promise.all(Array.from({ length: 4 }, async () => {
  while (queue.length) await runOne(queue.shift());
}));
