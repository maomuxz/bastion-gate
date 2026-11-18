// Shared fixtures for the v0.4 acceptance tests (locked together with the tests).
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runInit } from '../src/commands/init.js';
import { runLock } from '../src/commands/lock.js';

const tempDirs: string[] = [];

export function createTempGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bastion-v04-'));
  tempDirs.push(dir);
  git(['init', '-b', 'main'], dir);
  git(['config', 'user.email', 'test@bastion.local'], dir);
  git(['config', 'user.name', 'Bastion Test'], dir);
  return dir;
}

export function cleanupTempRepos(): void {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

export function writeRepoFile(repoDir: string, rel: string, content: string): void {
  const full = path.join(repoDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}

export function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

/** Capture console.log / console.error output while fn runs. */
export async function captureConsole<T>(fn: () => T | Promise<T>): Promise<{ result: T; out: string; err: string }> {
  const origLog = console.log;
  const origErr = console.error;
  const origWarn = console.warn;
  const out: string[] = [];
  const err: string[] = [];
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(' ')); };
  console.error = (...a: unknown[]) => { err.push(a.map(String).join(' ')); };
  console.warn = (...a: unknown[]) => { err.push(a.map(String).join(' ')); };
  try {
    const result = await fn();
    return { result, out: out.join('\n'), err: err.join('\n') };
  } finally {
    console.log = origLog;
    console.error = origErr;
    console.warn = origWarn;
  }
}

export interface FixtureNode {
  id: string;
  dependsOn?: string[];
}

export interface SwarmFixtureOptions {
  nodes: FixtureNode[];
  /** Body of scripts/agent.mjs. Default agent: makes src/<id>.mjs export <id> = 1. */
  agentScript?: string;
  /** Merged into .bastion/config.json before locking. */
  configPatch?: Record<string, unknown>;
}

/**
 * Default agent, usable as a building block: `implementNode()` writes the passing source
 * for the current node. Node ids must be valid JS identifiers.
 */
export const AGENT_PRELUDE = [
  `import * as fs from 'node:fs';`,
  `import { execFileSync } from 'node:child_process';`,
  `const id = process.env.BASTION_NODE_ID;`,
  `const prompt = fs.readFileSync(process.env.BASTION_PROMPT_FILE, 'utf8');`,
  `function implementNode() { fs.writeFileSync('src/' + id + '.mjs', 'export const ' + id + ' = 1;\\n'); }`,
  `function cli(...args) { return execFileSync(process.execPath, [process.env.BASTION_CLI, ...args], { encoding: 'utf8' }); }`,
].join('\n');

export const DEFAULT_AGENT = `${AGENT_PRELUDE}\nimplementNode();\n`;

/**
 * A committed + locked repo where every node has a red test tests/<id>.test.mjs
 * that passes once src/<id>.mjs exports <id> = 1.
 */
export function createSwarmRepo(opts: SwarmFixtureOptions): string {
  const repo = createTempGitRepo();
  runInit({ cwd: repo, testCommand: 'node --test tests/*.test.mjs', baseBranch: 'main' });

  for (const n of opts.nodes) {
    writeRepoFile(repo, `src/${n.id}.mjs`, `export const ${n.id} = 0;\n`);
    writeRepoFile(
      repo,
      `tests/${n.id}.test.mjs`,
      `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { ${n.id} } from '../src/${n.id}.mjs';\ntest('${n.id} is done', () => { assert.equal(${n.id}, 1); });\n`
    );
  }
  writeRepoFile(repo, 'scripts/agent.mjs', opts.agentScript ?? DEFAULT_AGENT);

  if (opts.configPatch) {
    const cfgPath = path.join(repo, '.bastion', 'config.json');
    const cfg = readJson<Record<string, unknown>>(cfgPath);
    fs.writeFileSync(cfgPath, JSON.stringify({ ...cfg, ...opts.configPatch }, null, 2) + '\n', 'utf8');
  }

  writeRepoFile(
    repo,
    '.bastion/plan.json',
    JSON.stringify(
      {
        version: 1,
        nodes: opts.nodes.map((n) => ({
          id: n.id,
          title: `Implement ${n.id}`,
          prompt: `Implement ${n.id}`,
          testCommand: `node --test tests/${n.id}.test.mjs`,
          ...(n.dependsOn ? { dependsOn: n.dependsOn } : {}),
          tier: 1,
        })),
      },
      null,
      2
    ) + '\n'
  );

  git(['add', '.'], repo);
  git(['commit', '-m', 'chore: fixture baseline'], repo);
  if (runLock({ cwd: repo }) !== 0) throw new Error('fixture: runLock failed');
  git(['add', '.bastion/lock.json'], repo);
  git(['commit', '-m', 'chore: lock'], repo);
  return repo;
}

export function readRunStateFile(repo: string): Record<string, unknown> {
  return readJson<Record<string, unknown>>(path.join(repo, '.bastion', 'run-state.json'));
}
