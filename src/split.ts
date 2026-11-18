import { BastionMap } from './map.js';

/** Maximum nesting: ids may have at most this many dot-separated segments (e.g. "a.b.c"). */
export const MAX_MAP_DEPTH = 3;

/** Number of dot-separated segments in a node id ("a" -> 1, "a.b" -> 2). */
export function mapDepth(id: string): number {
  return id.split('.').length;
}

/**
 * Replace node `parentId` in `map` with the nodes of `sub` (recursive decomposition), returning a new map:
 * - every sub node id becomes `${parentId}.${subId}`; dependsOn between sub nodes is prefixed the same way
 * - sub nodes with no dependsOn inside `sub` inherit the parent's dependsOn
 * - any node that depended on the parent now depends on every sub node id
 * - sub.interfaces is appended to map.interfaces under a "## <parentId>" heading
 * - node order: sub nodes take the parent's position; other nodes keep their order
 * - throws if parentId is unknown, if sub has no nodes, or if a resulting id exceeds MAX_MAP_DEPTH segments
 * Inputs are not mutated.
 */
export function splitNode(map: BastionMap, parentId: string, sub: BastionMap): BastionMap {
  const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
  const idx = map.nodes.findIndex((n) => n.id === parentId);
  if (idx < 0) throw new Error(`splitNode: unknown node id "${parentId}"`);
  if (sub.nodes.length === 0) throw new Error(`splitNode: sub map for "${parentId}" has no nodes`);
  const parent = map.nodes[idx];
  const subIds = new Set(sub.nodes.map((n) => n.id));
  const newIds = sub.nodes.map((n) => `${parentId}.${n.id}`);
  for (const id of newIds) {
    if (mapDepth(id) > MAX_MAP_DEPTH) {
      throw new Error(`splitNode: id "${id}" exceeds max depth ${MAX_MAP_DEPTH}`);
    }
  }
  const parentDeps = parent.dependsOn ?? [];
  const subNodes = sub.nodes.map((n) => {
    const copy = clone(n);
    const inner = (n.dependsOn ?? []).filter((d) => subIds.has(d));
    copy.id = `${parentId}.${n.id}`;
    copy.dependsOn = inner.length > 0 ? inner.map((d) => `${parentId}.${d}`) : [...parentDeps];
    return copy;
  });
  const nodes: BastionMap['nodes'] = [];
  map.nodes.forEach((n, i) => {
    if (i === idx) {
      nodes.push(...subNodes);
      return;
    }
    const copy = clone(n);
    if (copy.dependsOn && copy.dependsOn.includes(parentId)) {
      const out: string[] = [];
      for (const d of copy.dependsOn) {
        for (const r of d === parentId ? newIds : [d]) if (!out.includes(r)) out.push(r);
      }
      copy.dependsOn = out;
    }
    nodes.push(copy);
  });
  const heading = `## ${parentId}\n\n${sub.interfaces}`;
  const interfaces = map.interfaces ? `${map.interfaces.replace(/\s+$/, '')}\n\n${heading}` : heading;
  return { ...clone({ ...map, nodes: [] }), interfaces, nodes };
}
