// v1.0 P10 - recursive decomposition: mapDepth / splitNode contract from src/split.ts.
import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BastionMap, MapNode } from '../src/map.js';
import { MAX_MAP_DEPTH, mapDepth, splitNode } from '../src/split.js';

function node(id: string, extra: Partial<MapNode> = {}): MapNode {
  return {
    id,
    title: `Title ${id}`,
    summary: `Summary ${id}.`,
    files: [`src/${id.replace(/\./g, '_')}.mjs`],
    interface: `export function f_${id.replace(/\./g, '_')}(): void`,
    acceptance: [`${id} works`],
    testFile: `tests/${id.replace(/\./g, '_')}.test.mjs`,
    testCommand: `node --test tests/${id.replace(/\./g, '_')}.test.mjs`,
    ...extra,
  };
}

function mapOf(nodes: MapNode[], interfaces = 'Shared contracts.'): BastionMap {
  return { version: 1, requirement: 'req', interfaces, nodes };
}

/** n1 <- n2 <- n3 (also depends on n1), plus independent n4. Parent under test is usually n2. */
function bigMap(): BastionMap {
  return mapOf([
    node('n1'),
    node('n2', { dependsOn: ['n1'] }),
    node('n3', { dependsOn: ['n2', 'n1'] }),
    node('n4'),
  ]);
}

function subMap(): BastionMap {
  return mapOf(
    [node('s1', { title: 'Sub one', files: ['src/sub1.mjs'] }), node('s2', { dependsOn: ['s1'], files: ['src/sub2.mjs'] })],
    'Sub contracts text.'
  );
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const ids = (m: BastionMap): string[] => m.nodes.map((n) => n.id);
const sorted = (a: string[] | undefined): string[] => [...(a ?? [])].sort();
const byId = (m: BastionMap, id: string): MapNode => {
  const n = m.nodes.find((x) => x.id === id);
  assert.ok(n, `node ${id} missing in [${ids(m).join(', ')}]`);
  return n;
};

describe('v1.0 P10 mapDepth', () => {
  it('counts dot-separated segments and MAX_MAP_DEPTH is 3', () => {
    assert.equal(MAX_MAP_DEPTH, 3);
    assert.equal(mapDepth('a'), 1);
    assert.equal(mapDepth('n12'), 1);
    assert.equal(mapDepth('a.b'), 2);
    assert.equal(mapDepth('a.b.c'), 3);
    assert.equal(mapDepth('a.b.c.d'), 4);
  });
});

describe('v1.0 P10 splitNode', () => {
  it('replaces the parent with prefixed sub nodes, keeping position and the other nodes', () => {
    const out = splitNode(bigMap(), 'n2', subMap());
    assert.deepEqual(ids(out), ['n1', 'n2.s1', 'n2.s2', 'n3', 'n4']);
    assert.equal(out.nodes.some((n) => n.id === 'n2'), false);
    assert.equal(out.version, 1);
    assert.equal(out.requirement, 'req');
    // untouched nodes are identical (n3 is rewritten, so only check n1/n4)
    assert.deepEqual(byId(out, 'n1'), bigMap().nodes[0]);
    assert.deepEqual(byId(out, 'n4'), bigMap().nodes[3]);
    // sub node payload survives apart from id/dependsOn
    const s1 = byId(out, 'n2.s1');
    assert.equal(s1.title, 'Sub one');
    assert.deepEqual(s1.files, ['src/sub1.mjs']);
    assert.deepEqual(s1.acceptance, ['s1 works']);
    assert.equal(s1.testFile, 'tests/s1.test.mjs');
  });

  it('keeps first/last positions when the parent is first or last', () => {
    const first = splitNode(bigMap(), 'n1', subMap());
    assert.deepEqual(ids(first), ['n1.s1', 'n1.s2', 'n2', 'n3', 'n4']);
    const last = splitNode(bigMap(), 'n4', subMap());
    assert.deepEqual(ids(last), ['n1', 'n2', 'n3', 'n4.s1', 'n4.s2']);
  });

  it('prefixes internal dependsOn and lets root sub nodes inherit the parent dependsOn', () => {
    const out = splitNode(bigMap(), 'n2', subMap());
    assert.deepEqual(sorted(byId(out, 'n2.s1').dependsOn), ['n1'], 'root sub node inherits parent deps');
    assert.deepEqual(sorted(byId(out, 'n2.s2').dependsOn), ['n2.s1'], 'inner sub node must NOT inherit, only prefixed dep');
  });

  it('gives root sub nodes an empty dependency list when the parent has none', () => {
    const out = splitNode(bigMap(), 'n4', subMap());
    assert.deepEqual(sorted(byId(out, 'n4.s1').dependsOn), []);
    assert.deepEqual(sorted(byId(out, 'n4.s2').dependsOn), ['n4.s1']);
  });

  it('rewires dependants of the parent to every sub node, without duplicates or dangling ids', () => {
    const out = splitNode(bigMap(), 'n2', subMap());
    assert.deepEqual(sorted(byId(out, 'n3').dependsOn), ['n1', 'n2.s1', 'n2.s2']);
    // every dependsOn in the result points to an existing node
    const all = new Set(ids(out));
    for (const n of out.nodes) for (const d of n.dependsOn ?? []) assert.ok(all.has(d), `${n.id} depends on missing ${d}`);
    // nodes that did not depend on the parent are unchanged
    assert.deepEqual(byId(out, 'n4').dependsOn ?? [], []);
  });

  it('appends sub interfaces under a "## <parentId>" heading and keeps the existing ones', () => {
    const out = splitNode(bigMap(), 'n2', subMap());
    assert.ok(out.interfaces.startsWith('Shared contracts.'), 'original interfaces stay first');
    const h = out.interfaces.indexOf('## n2');
    assert.ok(h > 0, 'heading "## n2" appended');
    assert.ok(out.interfaces.indexOf('Sub contracts text.') > h, 'sub interfaces follow the heading');
    assert.equal(out.interfaces.split('Sub contracts text.').length, 2, 'appended exactly once');
  });

  it('does not mutate its inputs and returns a new map', () => {
    const m = bigMap();
    const s = subMap();
    const mBefore = clone(m);
    const sBefore = clone(s);
    const out = splitNode(m, 'n2', s);
    assert.notEqual(out, m);
    assert.deepEqual(m, mBefore);
    assert.deepEqual(s, sBefore);
    assert.notDeepEqual(ids(out), ids(m), 'the split actually happened');
    // mutating the result must not leak back into inputs
    out.nodes[0].files.push('x');
    assert.deepEqual(m, mBefore);
  });

  it('can split an already split node up to MAX_MAP_DEPTH, and rejects going deeper', () => {
    const once = splitNode(bigMap(), 'n2', subMap());
    const twice = splitNode(once, 'n2.s1', mapOf([node('a'), node('b', { dependsOn: ['a'] })]));
    assert.deepEqual(ids(twice), ['n1', 'n2.s1.a', 'n2.s1.b', 'n2.s2', 'n3', 'n4']);
    assert.equal(Math.max(...twice.nodes.map((n) => mapDepth(n.id))), MAX_MAP_DEPTH);
    // inherited from n2.s1's deps ([n1]); n2.s2 depended on n2.s1 and now on both children
    assert.deepEqual(sorted(byId(twice, 'n2.s1.a').dependsOn), ['n1']);
    assert.deepEqual(sorted(byId(twice, 'n2.s2').dependsOn), ['n2.s1.a', 'n2.s1.b']);
    assert.throws(() => splitNode(twice, 'n2.s1.a', mapOf([node('z')])), 'depth 4 must throw');
  });

  it('rejects a sub node whose own id is nested too deeply', () => {
    // "a" + "x.y" = depth 3 is fine
    const ok = splitNode(mapOf([node('a')]), 'a', mapOf([node('x.y')]));
    assert.deepEqual(ids(ok), ['a.x.y']);
    // "a.b" + "x.y" = depth 4 is not
    assert.throws(() => splitNode(mapOf([node('a.b')]), 'a.b', mapOf([node('x.y')])));
  });

  it('throws for an unknown parent id', () => {
    assert.throws(() => splitNode(bigMap(), 'nope', subMap()), /nope/);
    // a prefix of a real id is not a match
    assert.throws(() => splitNode(bigMap(), 'n', subMap()));
  });

  it('throws when the sub map has no nodes', () => {
    assert.throws(() => splitNode(bigMap(), 'n2', mapOf([])));
  });
});
