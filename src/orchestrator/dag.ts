import { PlanNode } from '../config.js';

/**
 * Group plan nodes into dependency waves using topological sorting.
 * Throws if there are duplicate IDs, missing dependencies, or cycles.
 */
export function buildExecutionWaves(nodes: PlanNode[]): PlanNode[][] {
  const byId = new Map<string, PlanNode>();
  for (const node of nodes) {
    if (!node.id || !node.id.trim()) {
      throw new Error('Plan node is missing a non-empty "id".');
    }
    if (byId.has(node.id)) {
      throw new Error(`Duplicate plan node id: "${node.id}".`);
    }
    byId.set(node.id, node);
  }

  // Validate dependencies exist
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const node of nodes) {
    const deps = node.dependsOn ?? [];
    inDegree.set(node.id, deps.length);
    for (const dep of deps) {
      if (!byId.has(dep)) {
        throw new Error(`Node "${node.id}" depends on unknown node "${dep}".`);
      }
      const list = dependents.get(dep) ?? [];
      list.push(node.id);
      dependents.set(dep, list);
    }
  }

  const waves: PlanNode[][] = [];
  let ready = nodes.filter((n) => (inDegree.get(n.id) ?? 0) === 0);
  let visited = 0;

  while (ready.length > 0) {
    waves.push(ready);
    visited += ready.length;
    const nextReady: PlanNode[] = [];
    for (const node of ready) {
      for (const childId of dependents.get(node.id) ?? []) {
        const nextDeg = (inDegree.get(childId) ?? 0) - 1;
        inDegree.set(childId, nextDeg);
        if (nextDeg === 0) {
          nextReady.push(byId.get(childId)!);
        }
      }
    }
    ready = nextReady;
  }

  if (visited !== nodes.length) {
    throw new Error('Cycle detected in plan dependencies.');
  }

  return waves;
}
