import * as fs from 'node:fs';
import * as path from 'node:path';
import { readPlanFromDisk } from '../config.js';
import { getRepoRoot } from '../git.js';
import { readRunState, writeRunState } from '../state.js';

export interface ReopenOptions {
  cwd: string;
  /** Plan node to rebuild. */
  node: string;
  /** Why (goes to the node's next prompt). */
  reason: string;
  /** Optional: a node that must wait until `node` is rebuilt. */
  before?: string;
}

/**
 * v1.1 `bastion reopen <node> --reason "<why>" [--before <other>]`: the formal way to rebuild a block that is already
 * merged - e.g. when a dispute shows that the locked test is right and an upstream block is wrong. Replaces hand-editing
 * .bastion/run-state.json.
 *
 * Errors (stderr `[bastion] reopen: ...`, return 1, nothing written): not in a git repo; no run-state; unreadable plan;
 * `node` is not a plan node id; blank reason; `before` given but not a plan node id, or equal to `node`, or `node`
 * already depends on `before` - directly or transitively, counting plan dependsOn and run-state extraDeps (that would
 * be a cycle).
 *
 * Effect: removes `node` from run-state completedNodes and blockedNodes (fine when it is in neither); appends the line
 * `- <reason trimmed>` to .bastion/feedback/<node>.md (created when missing; existing content kept; the next
 * `bastion run --resume` feeds it to the agent). With `before`: adds `node` to run-state extraDeps[before] (no
 * duplicates) so the scheduler builds `before` only after `node` is complete again; `before` is also removed from
 * blockedNodes, and stays in completedNodes if it was there. Every other run-state field is preserved.
 * Prints `[bastion] reopen: <node> will be rebuilt. Next: bastion run --resume` and returns 0.
 */
export function runReopen(opts: ReopenOptions): number {
  const fail = (msg: string): number => {
    console.error(`[bastion] reopen: ${msg}`);
    return 1;
  };
  const repoRoot = getRepoRoot(opts.cwd);
  if (!repoRoot) return fail('not inside a git repository.');
  const state = readRunState(repoRoot);
  if (!state) return fail('no .bastion/run-state.json found; nothing to reopen.');
  let nodes;
  try {
    nodes = readPlanFromDisk(repoRoot).nodes;
  } catch (err) {
    return fail(`cannot read the plan: ${err instanceof Error ? err.message : String(err)}`);
  }
  const ids = new Set(nodes.map((n) => n.id));
  const node = opts.node;
  if (!node || !ids.has(node)) return fail(`"${node}" is not a plan node id.`);
  const reason = (opts.reason ?? '').trim();
  if (!reason) return fail('a non-blank --reason is required.');
  const before = opts.before;
  if (before !== undefined) {
    if (!ids.has(before)) return fail(`--before "${before}" is not a plan node id.`);
    if (before === node) return fail('--before must be a different node than the one being reopened.');
    const extra = state.extraDeps ?? {};
    const depsOf = (id: string): string[] => [
      ...(nodes.find((n) => n.id === id)?.dependsOn ?? []),
      ...(extra[id] ?? []),
    ];
    const seen = new Set<string>();
    const stack = [node];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      for (const d of depsOf(cur)) {
        if (d === before) return fail(`"${node}" already depends on "${before}"; --before would create a cycle.`);
        if (!seen.has(d)) {
          seen.add(d);
          stack.push(d);
        }
      }
    }
  }

  state.completedNodes = state.completedNodes.filter((id) => id !== node);
  state.blockedNodes = (state.blockedNodes ?? []).filter((id) => id !== node && id !== before);
  if (before !== undefined) {
    const extra = { ...(state.extraDeps ?? {}) };
    const list = extra[before] ?? [];
    extra[before] = list.includes(node) ? list : [...list, node];
    state.extraDeps = extra;
  }

  const fb = path.join(repoRoot, '.bastion', 'feedback', `${node}.md`);
  fs.mkdirSync(path.dirname(fb), { recursive: true });
  let existing = fs.existsSync(fb) ? fs.readFileSync(fb, 'utf8') : '';
  if (existing && !existing.endsWith('\n')) existing += '\n';
  fs.writeFileSync(fb, `${existing}- ${reason}\n`, 'utf8');
  writeRunState(repoRoot, state);
  console.log(`[bastion] reopen: ${node} will be rebuilt. Next: bastion run --resume`);
  return 0;
}
