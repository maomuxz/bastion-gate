import * as fs from 'node:fs';
import * as path from 'node:path';
import { MAP_REL_PATH, readConfigFromDisk } from '../config.js';
import { execGit, getRepoRoot, gitIdentityArgs } from '../git.js';
import { readRunState } from '../state.js';
import { summaryLines } from '../summary.js';
import { PRESETS, chooseTier, describeSwitches, parseTier, resolveSwitches, tierHint } from '../tier.js';
import type { Switches, Tier } from '../tier.js';
import { runContract } from './contract.js';
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

interface FlowState { tier?: Tier; switches?: Switches; stages: Stage[] }

function readState(root: string): FlowState {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, FLOW_STATE_REL_PATH), 'utf8').replace(/^﻿/, '')) as {
      stages?: unknown; tier?: unknown; switches?: unknown;
    };
    const stages = Array.isArray(raw.stages) ? (raw.stages.filter((s) => typeof s === 'string') as Stage[]) : [];
    const tier = parseTier(raw.tier);
    if (tier && raw.switches && typeof raw.switches === 'object') {
      return { tier, switches: { ...PRESETS[tier], ...(raw.switches as Partial<Switches>) }, stages };
    }
    if (stages.length > 0) return { tier: 'capital', switches: { ...PRESETS.capital, secondMap: true }, stages };
    return { stages: [] };
  } catch {
    return { stages: [] };
  }
}

function writeState(root: string, st: FlowState): void {
  const file = path.join(root, FLOW_STATE_REL_PATH);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ tier: st.tier, switches: st.switches, stages: st.stages }, null, 2) + '\n', 'utf8');
}

/** v1.1: the commit uses gitIdentityArgs(root) (src/git.ts) instead of always forcing the bastion identity. */
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
  const res = execGit([...gitIdentityArgs(root), 'commit', '-m', 'chore(bastion): approved map', '--', ...candidates], root);
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
 *
 * v1.1 presets and switches (`bastion flow [--tier <village|city|capital>] ["<requirement>"]`, see src/tier.ts):
 *  - First call: tier = chooseTier(undefined, opts.tier); switches = resolveSwitches(tier, config.switches). An error from
 *    either prints `[bastion] flow: <error>` to stderr and returns 1 before any role call. Tier and switches are stored
 *    in .bastion/flow-state.json as { tier, switches, stages } and are fixed from then on: later calls use the stored
 *    switches (config changes are ignored) and chooseTier(recorded, opts.tier) - a different --tier returns 1 with its
 *    error, also when the flow is already done.
 *    A state file from v1.0 (no `tier`) with at least one stage counts as tier 'capital' with these switches:
 *    capital preset plus secondMap true (what v1.0 did); with no stage it counts as nothing recorded.
 *  - Every call prints `[bastion] flow: tier <tier> (<describeSwitches>).` first; on the first call, when the tier was
 *    defaulted, it then prints tierHint().
 *  - Stage 'map': switches.map false -> runContract({ cwd, requirement }) (one thin interface contract, approves itself).
 *    switches.map true -> runMap({ cwd, requirement, planners: switches.secondMap ? 2 : 1 }); then, when switches.split
 *    is on, every node of the written map that has `split: true` is split once with runMap({ cwd, parent: <id>,
 *    planners: same }) in map order (a failing split returns its code); with split off such flags are ignored.
 *  - Approval: switches.approval true -> stop with exit 2 until `bastion review --approve` (as in v1.0). false -> when
 *    the map is not approved yet, flow approves it itself with runReview({ cwd, approve: true }) and goes on in the same call.
 *  - Stage 'built': commit the map files; runScaffold only when switches.scaffold; runTests({ lock: true }).
 *  - Construction (first run, resume and the re-run after a failing QA): runSwarm with
 *    mode = switches.map ? 'swarm' : 'single', concurrency = switches.crew when crew > 0 (not passed when 0),
 *    questions = switches.questions and budget = switches.budget.
 *  - QA is the same whatever the switches say (it is part of the wall).
 */
export async function runFlow(opts: FlowOptions): Promise<number> {
  const root = getRepoRoot(opts.cwd) ?? opts.cwd;
  const state = readState(root);
  const stages = state.stages;

  const chosen = chooseTier(state.tier, opts.tier);
  if (!chosen.ok) {
    console.error(`[bastion] flow: ${chosen.error}`);
    return 1;
  }
  const firstCall = state.switches === undefined;
  let switches: Switches;
  if (state.switches) {
    switches = state.switches;
  } else {
    let overrides: unknown;
    try {
      overrides = readConfigFromDisk(root).switches;
    } catch (e) {
      console.error(`[bastion] flow: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
    const res = resolveSwitches(chosen.tier, overrides);
    if (!res.ok) {
      console.error(`[bastion] flow: ${res.error}`);
      return 1;
    }
    switches = res.switches;
  }
  state.tier = chosen.tier;
  state.switches = switches;
  console.log(`[bastion] flow: tier ${chosen.tier} (${describeSwitches(switches)}).`);
  if (stages.length > 0) writeState(root, state);
  if (firstCall && chosen.defaulted) for (const l of tierHint()) console.log(l);

  const mark = (s: Stage): void => {
    if (!stages.includes(s)) stages.push(s);
    writeState(root, state);
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
    if (!switches.map) {
      const code = await runContract({ cwd: root, requirement: opts.requirement });
      if (code !== 0) return code;
    } else {
      const planners = switches.secondMap ? 2 : 1;
      const code = await runMap({ cwd: root, requirement: opts.requirement, planners });
      if (code !== 0) return code;
      if (switches.split) {
        let ids: string[] = [];
        try {
          const m = JSON.parse(fs.readFileSync(path.join(root, MAP_REL_PATH), 'utf8').replace(/^﻿/, '')) as {
            nodes?: { id?: unknown; split?: unknown }[];
          };
          ids = (m.nodes ?? []).filter((n) => n.split === true && typeof n.id === 'string').map((n) => n.id as string);
        } catch {
          ids = [];
        }
        for (const id of ids) {
          const c = await runMap({ cwd: root, parent: id, planners });
          if (c !== 0) return c;
        }
      }
    }
    mark('map');
  }

  if (!isMapApproved(root)) {
    if (switches.approval) {
      const r = runReview({ cwd: root });
      if (r !== 0) return r;
      console.log('[bastion] flow: waiting for you. Run `bastion review --approve`, then `bastion flow`.');
      return 2;
    }
    const r = runReview({ cwd: root, approve: true });
    if (r !== 0) return r;
  }

  if (!stages.includes('built')) {
    if (!commitMapFiles(root)) return 1;
    let code = 0;
    if (switches.scaffold) {
      code = await runScaffold({ cwd: root });
      if (code !== 0) return code;
    }
    code = await runTests({ cwd: root, lock: true });
    if (code !== 0) return code;
    mark('built');
  }

  const swarmOpts = (resume: boolean): Parameters<typeof runSwarm>[0] => ({
    cwd: root,
    resume,
    mode: switches.map ? 'swarm' : 'single',
    ...(switches.crew > 0 ? { concurrency: switches.crew } : {}),
    questions: switches.questions,
    budget: switches.budget,
  });

  if (!stages.includes('swarm')) {
    const code = await swarmQuietMerge(swarmOpts(readRunState(root) !== null));
    if (code !== 0) return code; // 2 = answers needed, 3 = budget, 1 = failure
    mark('swarm');
  }

  let qa = await runQa({ cwd: root });
  if (qa !== 0) {
    const code = await swarmQuietMerge(swarmOpts(true));
    if (code === 2 || code === 3) return code; // answers / budget: a human is needed
    qa = await runQa({ cwd: root });
    if (qa !== 0) return qa;
  }

  mark('done');
  printDone(root);
  return 0;
}
