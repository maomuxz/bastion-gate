import * as fs from 'node:fs';
import * as path from 'node:path';
import { readConfigFromDisk } from '../config.js';
import { execGit, getRepoRoot } from '../git.js';
import { INTERFACES_REL_PATH, MAP_REL_PATH, type BastionMap } from '../map.js';
import { resolveAgentCommand, runRole } from '../roles.js';
import type { ScaffoldOptions } from './stages.js';

/** Read map.json with a light shape check (only what scaffold needs: nodes with id, files, interface). */
function loadMap(repoRoot: string): BastionMap | null {
  const p = path.join(repoRoot, MAP_REL_PATH);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')) as BastionMap;
    if (!raw || !Array.isArray(raw.nodes) || raw.nodes.length === 0) return null;
    for (const n of raw.nodes) {
      if (!n || typeof n.id !== 'string' || !Array.isArray(n.files) || n.files.length === 0) return null;
      if (typeof n.interface !== 'string') return null;
    }
    return raw;
  } catch {
    return null;
  }
}

/**
 * P12 `bastion scaffold`: one call to the worker role with interfaces.md and every node's files + interface, asking it to
 * create those files with the exact interfaces and placeholder bodies (no real logic) so tests can compile and fail on assertions.
 * Then checks every node file exists (missing -> 1) and commits them ("chore(bastion): scaffold"). Requires map.json.
 */
export async function runScaffold(opts: ScaffoldOptions): Promise<number> {
  const repoRoot = getRepoRoot(opts.cwd);
  if (!repoRoot) {
    console.error('[bastion] Error: not inside a git repository.');
    return 1;
  }
  const map = loadMap(repoRoot);
  if (!map) {
    console.error('[bastion] scaffold: .bastion/map.json is missing or invalid. Run `bastion map` first.');
    return 1;
  }
  const config = readConfigFromDisk(repoRoot);
  const command = resolveAgentCommand(config, 'worker');
  if (!command) {
    console.error('[bastion] scaffold: no worker agent configured (roles.worker or agentCommand).');
    return 1;
  }

  const ifacePath = path.join(repoRoot, INTERFACES_REL_PATH);
  const interfaces = fs.existsSync(ifacePath) ? fs.readFileSync(ifacePath, 'utf8') : map.interfaces;

  const nodeSections = map.nodes.map((n) =>
    [`### ${n.id}: ${n.title}`, `Files:`, ...n.files.map((f) => `- ${f}`), '', 'Interface:', n.interface].join('\n')
  );
  const prompt = [
    'You are scaffolding a project. Create EVERY file listed below with the exact public interfaces given,',
    'but use placeholder bodies only (e.g. throw new Error("not implemented") or a trivial return) - NO real logic.',
    'The files must compile/import so that tests can run and fail on assertions. Do not write tests. Do not commit.',
    '',
    '## Shared interfaces',
    interfaces,
    '',
    '## Nodes',
    nodeSections.join('\n\n'),
    '',
  ].join('\n');

  const timeoutMinutes = opts.timeoutMinutes ?? config.timeoutMinutes;
  const res = await runRole(command, 'worker', {
    prompt,
    cwd: repoRoot,
    repoRoot,
    label: 'scaffold',
    ...(timeoutMinutes && timeoutMinutes > 0 ? { timeoutMs: timeoutMinutes * 60_000 } : {}),
  });
  if (res.exitCode !== 0) {
    console.error(`[bastion] scaffold: worker failed (exit ${res.exitCode}${res.timedOut ? ', timed out' : ''}).`);
    return 1;
  }

  const files = [...new Set(map.nodes.flatMap((n) => n.files.map((f) => f.replace(/\\/g, '/'))))];
  const missing = files.filter((f) => !fs.existsSync(path.join(repoRoot, f)));
  if (missing.length > 0) {
    console.error(`[bastion] scaffold: missing node files after worker ran: ${missing.join(', ')}`);
    return 1;
  }

  const add = execGit(['add', '--', ...files], repoRoot);
  if (!add.ok) {
    console.error(`[bastion] scaffold: git add failed: ${add.stderr}`);
    return 1;
  }
  const commit = execGit(['commit', '-m', 'chore(bastion): scaffold', '--', ...files], repoRoot);
  if (!commit.ok) {
    console.error(`[bastion] scaffold: git commit failed: ${commit.stderr || commit.stdout}`);
    return 1;
  }
  console.log(`[bastion] scaffold: committed ${files.length} file(s).`);
  return 0;
}
