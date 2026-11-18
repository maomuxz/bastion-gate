// Shared fixtures for v0.5 / v1.0 tests: a scripted fake "AI" for every role, so no test calls a real model.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runInit } from '../src/commands/init.js';
import type { BastionMap } from '../src/map.js';
import { createTempGitRepo, git, readJson, writeRepoFile } from './v04-helpers.js';

/**
 * Behaviour of the fake role script, stored in <repo>/role-fixtures.json.
 * Keys: a role name ("planner" | "blind" | "tester" | "worker" | "qa") for runRole calls (env BASTION_ROLE),
 * or "run" for `bastion run` construction agents (no BASTION_ROLE; looked up by BASTION_NODE_ID).
 * A RoleFixture may be given per role, or per label/node id under `byLabel`.
 */
export interface RoleFixture {
  /** JSON value written to BASTION_OUTPUT (e.g. a BastionMap for planners, a QaReport for qa). */
  output?: unknown;
  /** Files written relative to the process cwd: { "src/a.mjs": "..." }. */
  files?: Record<string, string>;
  /** Process exit code (default 0). */
  exit?: number;
}
export interface RoleFixtures {
  [role: string]: (RoleFixture & { byLabel?: Record<string, RoleFixture> }) | undefined;
}

/**
 * scripts/role.mjs: applies the fixture and appends {role, label, prompt} to <BASTION_HOME>/.bastion/logs/role-calls.jsonl
 * (read it with readRoleCalls) so tests can check who was called and what they were told.
 */
export const ROLE_SCRIPT = [
  `import * as fs from 'node:fs';`,
  `import * as path from 'node:path';`,
  `const role = process.env.BASTION_ROLE || 'run';`,
  `const label = process.env.BASTION_NODE_ID || '';`,
  `const home = process.env.BASTION_HOME || process.cwd();`,
  `const prompt = process.env.BASTION_PROMPT_FILE ? fs.readFileSync(process.env.BASTION_PROMPT_FILE, 'utf8') : '';`,
  `fs.mkdirSync(path.join(home, '.bastion', 'logs'), { recursive: true });`,
  `fs.appendFileSync(path.join(home, '.bastion', 'logs', 'role-calls.jsonl'), JSON.stringify({ role, label, prompt }) + '\\n');`,
  `const all = JSON.parse(fs.readFileSync('role-fixtures.json', 'utf8'));`,
  `const base = all[role] || {};`,
  `const fx = (base.byLabel && base.byLabel[label]) || base;`,
  `if (fx.output !== undefined && process.env.BASTION_OUTPUT) {`,
  `  fs.mkdirSync(path.dirname(process.env.BASTION_OUTPUT), { recursive: true });`,
  `  fs.writeFileSync(process.env.BASTION_OUTPUT, JSON.stringify(fx.output, null, 2));`,
  `}`,
  `for (const [rel, content] of Object.entries(fx.files || {})) {`,
  `  fs.mkdirSync(path.dirname(rel), { recursive: true });`,
  `  fs.writeFileSync(rel, content);`,
  `}`,
  `process.exit(fx.exit ?? 0);`,
].join('\n') + '\n';

export interface RoleRepoOptions {
  fixtures: RoleFixtures;
  /** Merged into .bastion/config.json (roles for every role already point at scripts/role.mjs). */
  configPatch?: Record<string, unknown>;
  /** Extra files committed with the baseline. */
  files?: Record<string, string>;
  /** Default 'node --test tests/*.test.mjs'. */
  testCommand?: string;
}

/** A committed repo whose every role (and agentCommand) is the fake role script. Not locked, no plan. */
export function createRoleRepo(opts: RoleRepoOptions): string {
  const repo = createTempGitRepo();
  runInit({ cwd: repo, testCommand: opts.testCommand ?? 'node --test tests/*.test.mjs', baseBranch: 'main' });
  const cmd = 'node scripts/role.mjs';
  const cfgPath = path.join(repo, '.bastion', 'config.json');
  const cfg = readJson<Record<string, unknown>>(cfgPath);
  fs.writeFileSync(
    cfgPath,
    JSON.stringify({ ...cfg, agentCommand: cmd, roles: { planner: cmd, blind: cmd, tester: cmd, worker: cmd, qa: cmd }, ...opts.configPatch }, null, 2) + '\n'
  );
  writeRepoFile(repo, 'scripts/role.mjs', ROLE_SCRIPT);
  writeRepoFile(repo, 'role-fixtures.json', JSON.stringify(opts.fixtures, null, 2));
  for (const [rel, content] of Object.entries(opts.files ?? {})) writeRepoFile(repo, rel, content);
  git(['add', '.'], repo);
  git(['commit', '-m', 'chore: role fixture baseline'], repo);
  return repo;
}

/** Replace role-fixtures.json and commit it (use between stages). */
export function setFixtures(repo: string, fixtures: RoleFixtures): void {
  writeRepoFile(repo, 'role-fixtures.json', JSON.stringify(fixtures, null, 2));
  git(['add', 'role-fixtures.json'], repo);
  git(['commit', '-m', 'chore: fixtures'], repo);
}

export function readRoleCalls(repo: string): Array<{ role: string; label: string; prompt: string }> {
  const p = path.join(repo, '.bastion', 'logs', 'role-calls.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
}

/** A valid two-node map for a tiny calculator: n1 add (src/add.mjs), n2 mul depends on n1 (src/mul.mjs). */
export function sampleMap(): BastionMap {
  return {
    version: 1,
    requirement: 'A tiny calculator with add and mul.',
    interfaces: 'ES modules under src/, one function per file.',
    nodes: [
      {
        id: 'n1',
        title: 'Add',
        summary: 'Export add(a, b) returning the sum.',
        files: ['src/add.mjs'],
        interface: 'export function add(a: number, b: number): number',
        acceptance: ['add(2, 3) is 5'],
        testFile: 'tests/add.test.mjs',
        testCommand: 'node --test tests/add.test.mjs',
      },
      {
        id: 'n2',
        title: 'Mul',
        summary: 'Export mul(a, b) returning the product, built on add.',
        files: ['src/mul.mjs'],
        dependsOn: ['n1'],
        interface: 'export function mul(a: number, b: number): number',
        acceptance: ['mul(4, 5) is 20'],
        testFile: 'tests/mul.test.mjs',
        testCommand: 'node --test tests/mul.test.mjs',
      },
    ],
  };
}

/** Real file contents for the sample map: stub (scaffold), red test (tester) and implementation (run). */
export const SAMPLE_FILES = {
  stubs: {
    'src/add.mjs': 'export function add(a, b) { return 0; }\n',
    'src/mul.mjs': 'export function mul(a, b) { return 0; }\n',
  },
  tests: {
    'tests/add.test.mjs': `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/add.mjs';\ntest('add', () => { assert.equal(add(2, 3), 5); });\n`,
    'tests/mul.test.mjs': `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { mul } from '../src/mul.mjs';\ntest('mul', () => { assert.equal(mul(4, 5), 20); });\n`,
  },
  impl: {
    'src/add.mjs': 'export function add(a, b) { return a + b; }\n',
    'src/mul.mjs': "import { add } from './add.mjs';\nexport function mul(a, b) { let r = 0; for (let i = 0; i < b; i++) r = add(r, a); return r; }\n",
  },
} as const;
