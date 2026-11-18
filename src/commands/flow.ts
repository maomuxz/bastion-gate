import * as fs from 'node:fs';
import * as path from 'node:path';
import { execGit, getRepoRoot } from '../git.js';
import { readRunState } from '../state.js';
import { summaryLines } from '../summary.js';
import { runMap } from './map.js';
import { runQa } from './qa.js';
import { isMapApproved } from './review.js';
import { runReview } from './review.js';
import { runScaffold } from './scaffold.js';
import { runSwarm } from './run.js';
import { FLOW_STATE_REL_PATH } from './stages.js';
import type { FlowOptions } from './stages.js';
import { runTests } from './tests.js';

type Stage = 'map' | 'built' | 'swarm' | 'done';

function readStages(root: string): Stage[] {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, FLOW_STATE_REL_PATH), 'utf8').replace(/^﻿/, '')) as { stages?: unknown };
    return Array.isArray(raw.stages) ? (raw.stages.filter((s) => typeof s === 'string') as Stage[]) : [];
  } catch {
    return [];
  }
}

function writeStages(root: string, stages: Stage[]): void {
  const file = path.join(root, FLOW_STATE_REL_PATH);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ stages }, null, 2) + '\n', 'utf8');
}

function commitMapFiles(root: string): boolean {
  const candidates = [
    '.bastion/map.json', '.bastion/map-diff.md', '.bastion/interfaces.md', '.bastion/acceptance.md',
    '.bastion/plan.json', '.bastion/approval.json', '.bastion/brief.md', '.bastion/requirement.md', '.bastion/config.json',
  ].filter((f) => fs.existsSync(path.join(root, f)) && !execGit(['check-ignore', '-q', '--', f], root).ok);
  if (candidates.length === 0) return true;
  const add = execGit(['add', '--', ...candidates], root);
  if (!add.ok) {
    console.error(`[bastion] flow: git add failed: ${add.stderr}`);
    return false;
  }
  if (execGit(['diff', '--cached', '--quiet', '--', ...candidates], root).ok) return true;
  const res = execGit(['-c', 'user.name=bastion', '-c', 'user.email=bastion@local', 'commit', '-m', 'chore(bastion): approved map', '--', ...candidates], root);
  if (!res.ok) {
    console.error(`[bastion] flow: git commit failed: ${res.stderr || res.stdout}`);
    return false;
  }
  return true;
}

/** runSwarm prints its own merge hint when the swarm finishes; flow only offers a merge once QA has passed. */
async function swarmQuietMerge(opts: Parameters<typeof runSwarm>[0]): Promise<number> {
  const orig = console.log;
  console.log = (...args: unknown[]): void => {
    const text = args.map(String).join(' ');
    if (/merge/i.test(text) && (/git (checkout|merge)/.test(text) || /All nodes merged/.test(text))) return;
    orig(...args);
  };
  try {
    return await runSwarm(opts);
  } finally {
    console.log = orig;
  }
}

function printDone(root: string): void {
  for (const l of summaryLines(root)) console.log(l);
  const branch = readRunState(root)?.integrationBranch;
  if (branch) console.log(`[bastion] flow: done. Review and merge the integration branch: git merge ${branch}`);
  else console.log('[bastion] flow: done. Nothing to merge.');
}

/**
 * P8 `bastion flow ["<requirement>"]` - the four human appearances in one resumable command (.bastion/flow-state.json):
 * 1) requirement: runMap, then print the brief and return 2 ("bastion review --approve, then bastion flow").
 * 2) review: until isMapApproved, print the brief and return 2.
 *    Once approved: commit map files, runScaffold, runTests({lock:true}), then runSwarm. runSwarm 2/3 -> return it (3rd appearance:
 *    answers / budget). runSwarm 0 -> runQa; qa fail -> one runSwarm({resume:true}) then runQa again.
 * 4) done: print summaryLines and the merge instruction for the integration branch; return 0.
 * Each finished stage is recorded so re-running `bastion flow` continues where it stopped. Any failing stage -> its exit code.
 */
export async function runFlow(opts: FlowOptions): Promise<number> {
  const root = getRepoRoot(opts.cwd) ?? opts.cwd;
  const stages = readStages(root);
  const mark = (s: Stage): void => {
    if (!stages.includes(s)) stages.push(s);
    writeStages(root, stages);
  };

  if (stages.includes('done')) {
    printDone(root);
    return 0;
  }

  if (!stages.includes('map')) {
    if (!opts.requirement || !opts.requirement.trim()) {
      console.error('[bastion] flow: a requirement is required the first time (bastion flow "<requirement>").');
      return 1;
    }
    const code = await runMap({ cwd: root, requirement: opts.requirement });
    if (code !== 0) return code;
    mark('map');
  }

  if (!stages.includes('built') || !isMapApproved(root)) {
    if (!isMapApproved(root)) {
      const r = runReview({ cwd: root });
      if (r !== 0) return r;
      console.log('[bastion] flow: waiting for you. Run `bastion review --approve`, then `bastion flow`.');
      return 2;
    }
  }

  if (!stages.includes('built')) {
    if (!commitMapFiles(root)) return 1;
    let code = await runScaffold({ cwd: root });
    if (code !== 0) return code;
    code = await runTests({ cwd: root, lock: true });
    if (code !== 0) return code;
    mark('built');
  }

  if (!stages.includes('swarm')) {
    const code = await swarmQuietMerge({ cwd: root, resume: readRunState(root) !== null });
    if (code !== 0) return code; // 2 = answers needed, 3 = budget, 1 = failure
    mark('swarm');
  }

  let qa = await runQa({ cwd: root });
  if (qa !== 0) {
    const code = await swarmQuietMerge({ cwd: root, resume: true });
    if (code === 2 || code === 3) return code; // answers / budget: a human is needed
    qa = await runQa({ cwd: root });
    if (qa !== 0) return qa;
  }

  mark('done');
  printDone(root);
  return 0;
}
