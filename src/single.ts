import { BastionConfig, PlanNode } from './config.js';

/** Id of the synthetic node used in single mode. */
export const SINGLE_NODE_ID = 'all-nodes';

export type RunMode = 'swarm' | 'single';

/**
 * Pick the run mode. `requested` (CLI --single / --swarm) wins; then config.runMode: 'swarm' / 'single' as given,
 * 'auto' -> single when nodeCount <= (config.singleMaxNodes ?? 3), else swarm. runMode unset -> swarm.
 */
export function resolveRunMode(config: BastionConfig, requested: RunMode | undefined, nodeCount: number): RunMode {
  if (requested) return requested;
  if (config.runMode === 'single' || config.runMode === 'swarm') return config.runMode;
  if (config.runMode === 'auto') return nodeCount <= (config.singleMaxNodes ?? 3) ? 'single' : 'swarm';
  return 'swarm';
}

/**
 * Merge all plan nodes into one node for a single agent session:
 * id SINGLE_NODE_ID, title "All nodes (<n>)", testCommand = the given full testCommand, no dependsOn, tier 1.
 * The prompt lists every node in dependency order (topological; ties keep plan order) as
 * "## <i>. <id>: <title>" followed by that node's prompt, and says to finish them in that order.
 */
export function mergeNodesForSingle(nodes: PlanNode[], testCommand: string): PlanNode {
  const remaining = nodes.slice();
  const done = new Set<string>();
  const known = new Set(nodes.map((n) => n.id));
  const ordered: PlanNode[] = [];
  while (remaining.length > 0) {
    let idx = remaining.findIndex((n) => (n.dependsOn ?? []).every((d) => done.has(d) || !known.has(d)));
    if (idx < 0) idx = 0; // cycle guard: keep plan order
    const [next] = remaining.splice(idx, 1);
    ordered.push(next);
    done.add(next.id);
  }
  const body = ordered.map((n, i) => `## ${i + 1}. ${n.id}: ${n.title}\n\n${n.prompt}`).join('\n\n');
  const prompt = `Complete all of the following nodes in one session. Finish them in this order, one after another:\n\n${body}\n`;
  return { id: SINGLE_NODE_ID, title: `All nodes (${nodes.length})`, prompt, testCommand, tier: 1 };
}
