// v1.0 - map core: validateMap, diffMaps, renderers, mapToPlan, readMap/writeJson/writeText.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  BastionMap,
  MapNode,
  diffMaps,
  mapToPlan,
  readMap,
  renderAcceptance,
  renderInterfaces,
  renderMapDiff,
  validateMap,
  writeJson,
  writeText,
} from '../src/map.js';
import { cleanupTempRepos, createTempGitRepo } from './v04-helpers.js';
import { sampleMap } from './v1-helpers.js';

afterEach(cleanupTempRepos);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
function errorsOf(raw: unknown): string[] {
  const v = validateMap(raw);
  assert.equal(v.ok, false, 'expected validation to fail');
  return v.ok ? [] : v.errors;
}
function node(id: string, files: string[], dependsOn?: string[]): MapNode {
  return {
    id,
    title: `T-${id}`,
    summary: `S-${id}`,
    files,
    ...(dependsOn ? { dependsOn } : {}),
    interface: `I-${id}`,
    acceptance: [`A-${id}`],
    testFile: `tests/${id}.test.mjs`,
    testCommand: `node --test tests/${id}.test.mjs`,
  };
}
function mapOf(...nodes: MapNode[]): BastionMap {
  return { version: 1, requirement: 'r', interfaces: 'shared', nodes };
}

describe('validateMap', () => {
  it('accepts the sample map and defaults dependsOn to []', () => {
    const v = validateMap(sampleMap());
    assert.equal(v.ok, true);
    if (!v.ok) return;
    assert.deepEqual(v.map.nodes[0].dependsOn, []);
    assert.deepEqual(v.map.nodes[1].dependsOn, ['n1']);
    assert.equal(v.map.version, 1);
  });

  it('does not mutate its input', () => {
    const raw = sampleMap();
    const before = clone(raw);
    validateMap(raw);
    assert.deepEqual(raw, before);
  });

  it('rejects non-objects, wrong version, non-string requirement/interfaces', () => {
    for (const bad of [null, undefined, 'x', 42, [], true]) assert.ok(errorsOf(bad).length > 0);
    assert.ok(errorsOf({ ...sampleMap(), version: 2 }).some((e) => /version/i.test(e)));
    assert.ok(errorsOf({ ...sampleMap(), requirement: 5 }).some((e) => /requirement/i.test(e)));
    assert.ok(errorsOf({ ...sampleMap(), interfaces: null }).some((e) => /interfaces/i.test(e)));
  });

  it('rejects missing, empty or non-array nodes', () => {
    const m = sampleMap() as unknown as Record<string, unknown>;
    delete m.nodes;
    assert.ok(errorsOf(m).some((e) => /nodes/i.test(e)));
    assert.ok(errorsOf({ ...sampleMap(), nodes: [] }).some((e) => /nodes/i.test(e)));
    assert.ok(errorsOf({ ...sampleMap(), nodes: 'n1' }).some((e) => /nodes/i.test(e)));
  });

  it('rejects each empty / missing / blank required node field and names the field', () => {
    for (const field of ['id', 'title', 'summary', 'interface', 'testFile', 'testCommand']) {
      for (const bad of ['', '   ', undefined, 7]) {
        const m = clone(sampleMap()) as unknown as { nodes: Record<string, unknown>[] };
        if (bad === undefined) delete m.nodes[0][field];
        else m.nodes[0][field] = bad;
        const errs = errorsOf(m);
        assert.ok(errs.some((e) => e.includes(field)), `field ${field}=${String(bad)} should be reported, got ${errs.join('|')}`);
      }
    }
  });

  it('rejects empty/non-string files and acceptance arrays', () => {
    for (const field of ['files', 'acceptance']) {
      for (const bad of [[], [''], [3], 'src/a.mjs', undefined]) {
        const m = clone(sampleMap()) as unknown as { nodes: Record<string, unknown>[] };
        if (bad === undefined) delete m.nodes[0][field];
        else m.nodes[0][field] = bad;
        assert.ok(errorsOf(m).some((e) => e.includes(field)), `${field}=${JSON.stringify(bad)}`);
      }
    }
  });

  it('rejects a non-object node entry without throwing', () => {
    assert.ok(errorsOf({ ...sampleMap(), nodes: [null, 'x'] }).length > 0);
  });

  it('rejects duplicate ids and names the id', () => {
    const errs = errorsOf(mapOf(node('a', ['src/a.mjs']), node('a', ['src/b.mjs'])));
    assert.ok(errs.some((e) => /duplicate|unique/i.test(e) && e.includes('a')));
  });

  it('rejects unknown dependsOn ids and names both node and missing id', () => {
    const errs = errorsOf(mapOf(node('a', ['src/a.mjs'], ['ghost'])));
    assert.ok(errs.some((e) => e.includes('ghost') && e.includes('a')));
  });

  it('rejects self-dependency, 2-cycles and long cycles; accepts diamonds', () => {
    assert.ok(errorsOf(mapOf(node('a', ['src/a.mjs'], ['a']))).some((e) => /cycle/i.test(e)));
    assert.ok(errorsOf(mapOf(node('a', ['src/a.mjs'], ['b']), node('b', ['src/b.mjs'], ['a']))).some((e) => /cycle/i.test(e)));
    const ring = mapOf(node('a', ['src/a.mjs'], ['c']), node('b', ['src/b.mjs'], ['a']), node('c', ['src/c.mjs'], ['b']), node('d', ['src/d.mjs']));
    assert.ok(errorsOf(ring).some((e) => /cycle/i.test(e)));
    const diamond = mapOf(node('a', ['src/a.mjs']), node('b', ['src/b.mjs'], ['a']), node('c', ['src/c.mjs'], ['a']), node('d', ['src/d.mjs'], ['b', 'c']));
    assert.equal(validateMap(diamond).ok, true);
  });

  it('rejects a file owned by two nodes, naming the file', () => {
    const errs = errorsOf(mapOf(node('a', ['src/a.mjs', 'src/shared.mjs']), node('b', ['src/b.mjs', 'src/shared.mjs'])));
    assert.ok(errs.some((e) => e.includes('src/shared.mjs')));
  });

  it('rejects a testFile that is listed in any node files (own or another node)', () => {
    const own = mapOf({ ...node('a', ['src/a.mjs']), files: ['src/a.mjs', 'tests/a.test.mjs'] });
    assert.ok(errorsOf(own).some((e) => e.includes('tests/a.test.mjs')));
    const other = mapOf(node('a', ['src/a.mjs']), { ...node('b', ['tests/a.test.mjs']) });
    assert.ok(errorsOf(other).some((e) => e.includes('tests/a.test.mjs')));
  });

  it('reports multiple independent problems in one call', () => {
    const m = clone(sampleMap());
    m.nodes[0].title = '';
    m.nodes[1].dependsOn = ['ghost'];
    const errs = errorsOf(m);
    assert.ok(errs.length >= 2, errs.join('|'));
  });
});

describe('diffMaps', () => {
  it('reports no differences for identical maps', () => {
    const d = diffMaps(sampleMap(), sampleMap());
    assert.deepEqual(d, { onlyInA: [], onlyInB: [], dependencyDiffs: [], ownershipDiffs: [] });
  });

  it('matches nodes by id and lists ones present on only one side', () => {
    const a = mapOf(node('a', ['src/a.mjs']), node('b', ['src/b.mjs']));
    const b = mapOf(node('b', ['src/b.mjs']), node('c', ['src/c.mjs']));
    const d = diffMaps(a, b);
    assert.deepEqual(d.onlyInA, ['a']);
    assert.deepEqual(d.onlyInB, ['c']);
  });

  it('reports dependsOn differences for shared nodes in the documented line format, order-insensitive', () => {
    const a = mapOf(node('n1', ['src/1.mjs']), node('n2', ['src/2.mjs'], ['n1']), node('n3', ['src/3.mjs'], ['n1', 'n2']));
    const b = mapOf(node('n1', ['src/1.mjs']), node('n2', ['src/2.mjs']), node('n3', ['src/3.mjs'], ['n2', 'n1']));
    const d = diffMaps(a, b);
    assert.deepEqual(d.dependencyDiffs, ['n2: A depends on [n1] / B depends on []']);
  });

  it('treats missing dependsOn the same as []', () => {
    const a = mapOf(node('x', ['src/x.mjs']));
    const b = mapOf({ ...node('x', ['src/x.mjs']), dependsOn: [] });
    assert.deepEqual(diffMaps(a, b).dependencyDiffs, []);
  });

  it('reports files owned by different nodes, or owned in only one map', () => {
    const a = mapOf(node('a', ['src/a.mjs', 'src/shared.mjs']), node('b', ['src/b.mjs']));
    const b = mapOf(node('a', ['src/a.mjs']), node('b', ['src/b.mjs', 'src/shared.mjs', 'src/extra.mjs']));
    const d = diffMaps(a, b);
    assert.equal(d.ownershipDiffs.length, 2);
    assert.ok(d.ownershipDiffs.some((l) => l.includes('src/shared.mjs') && l.includes('a') && l.includes('b')));
    assert.ok(d.ownershipDiffs.some((l) => l.includes('src/extra.mjs')));
    assert.ok(!d.ownershipDiffs.some((l) => l.includes('src/a.mjs')));
  });

  it('reports a file owned in only one map even when its owner id is not shared', () => {
    const a = mapOf(node('a', ['src/a.mjs']));
    const b = mapOf(node('z', ['src/a.mjs']));
    const d = diffMaps(a, b);
    assert.deepEqual(d.onlyInA, ['a']);
    assert.deepEqual(d.onlyInB, ['z']);
    assert.ok(d.ownershipDiffs.some((l) => l.includes('src/a.mjs')));
  });
});

describe('renderMapDiff', () => {
  it('says "No differences." under a "# Map diff" heading when empty', () => {
    const md = renderMapDiff({ onlyInA: [], onlyInB: [], dependencyDiffs: [], ownershipDiffs: [] });
    assert.ok(md.startsWith('# Map diff'));
    assert.match(md, /^No differences\.$/m);
    assert.ok(!/^## /m.test(md));
  });

  it('renders one section per non-empty list, with "- " items, and no "No differences."', () => {
    const md = renderMapDiff({ onlyInA: ['a1', 'a2'], onlyInB: [], dependencyDiffs: ['n2: A depends on [n1] / B depends on []'], ownershipDiffs: [] });
    assert.ok(md.startsWith('# Map diff'));
    assert.match(md, /^## Only in planner map$/m);
    assert.match(md, /^## Dependencies$/m);
    assert.ok(!/^## Only in blind map$/m.test(md));
    assert.ok(!/^## File ownership$/m.test(md));
    assert.match(md, /^- a1$/m);
    assert.match(md, /^- a2$/m);
    assert.match(md, /^- n2: A depends on \[n1\] \/ B depends on \[\]$/m);
    assert.ok(!md.includes('No differences.'));
  });

  it('renders the blind-map and ownership sections', () => {
    const md = renderMapDiff({ onlyInA: [], onlyInB: ['z'], dependencyDiffs: [], ownershipDiffs: ['src/x.mjs: A owns by a / B owns by b'] });
    assert.match(md, /^## Only in blind map$/m);
    assert.match(md, /^## File ownership$/m);
    assert.match(md, /^- z$/m);
    assert.match(md, /^- src\/x\.mjs: /m);
  });

  it('works end to end with diffMaps', () => {
    const a = mapOf(node('a', ['src/a.mjs']));
    const md = renderMapDiff(diffMaps(a, mapOf(node('a', ['src/a.mjs']), node('b', ['src/b.mjs']))));
    assert.match(md, /^## Only in blind map$/m);
    assert.match(md, /^- b$/m);
  });
});

describe('renderInterfaces / renderAcceptance', () => {
  it('renderInterfaces: heading, shared interfaces, then a section per node in order', () => {
    const md = renderInterfaces(sampleMap());
    assert.ok(md.startsWith('# Interfaces'));
    const iShared = md.indexOf('ES modules under src/, one function per file.');
    const i1 = md.indexOf('## n1 Add');
    const i2 = md.indexOf('## n2 Mul');
    assert.ok(iShared > 0 && i1 > iShared && i2 > i1, `order wrong: ${iShared} ${i1} ${i2}`);
    const n1Body = md.slice(i1, i2);
    assert.ok(n1Body.includes('export function add(a: number, b: number): number'));
    assert.ok(!n1Body.includes('export function mul'));
    assert.ok(md.slice(i2).includes('export function mul(a: number, b: number): number'));
  });

  it('renderAcceptance: heading and one "- " line per acceptance item under its node', () => {
    const m = clone(sampleMap());
    m.nodes[0].acceptance = ['add(2, 3) is 5', 'add(-1, 1) is 0'];
    const md = renderAcceptance(m);
    assert.ok(md.startsWith('# Acceptance'));
    const i1 = md.indexOf('## n1 Add');
    const i2 = md.indexOf('## n2 Mul');
    assert.ok(i1 >= 0 && i2 > i1);
    const n1 = md.slice(i1, i2);
    assert.match(n1, /^- add\(2, 3\) is 5$/m);
    assert.match(n1, /^- add\(-1, 1\) is 0$/m);
    assert.match(md.slice(i2), /^- mul\(4, 5\) is 20$/m);
    assert.ok(!n1.includes('mul(4, 5)'));
  });
});

describe('mapToPlan', () => {
  it('produces one plan node per map node with id/title/dependsOn/testCommand/tier', () => {
    const plan = mapToPlan(sampleMap());
    assert.equal(plan.version, 1);
    assert.equal(plan.nodes.length, 2);
    assert.deepEqual(plan.nodes.map((n) => n.id), ['n1', 'n2']);
    assert.deepEqual(plan.nodes.map((n) => n.title), ['Add', 'Mul']);
    assert.deepEqual(plan.nodes[0].dependsOn ?? [], []);
    assert.deepEqual(plan.nodes[1].dependsOn, ['n1']);
    assert.equal(plan.nodes[0].testCommand, 'node --test tests/add.test.mjs');
    assert.equal(plan.nodes[1].testCommand, 'node --test tests/mul.test.mjs');
    assert.ok(plan.nodes.every((n) => n.tier === 1));
  });

  it('prompt carries summary, Edit only line, interface, every acceptance sentence, locked tests and test command', () => {
    const m = clone(sampleMap());
    m.nodes[0].files = ['src/add.mjs', 'src/add-helpers.mjs'];
    m.nodes[0].acceptance = ['add(2, 3) is 5', 'add handles negatives'];
    const p = mapToPlan(m).nodes[0].prompt;
    assert.ok(p.includes('Export add(a, b) returning the sum.'));
    assert.ok(p.includes('Edit only: src/add.mjs, src/add-helpers.mjs'));
    assert.ok(p.includes('export function add(a: number, b: number): number'));
    assert.ok(p.includes('add(2, 3) is 5'));
    assert.ok(p.includes('add handles negatives'));
    assert.ok(p.includes('Locked tests: tests/add.test.mjs'));
    assert.ok(p.includes('Your node test command: node --test tests/add.test.mjs'));
  });

  it("does not leak another node's details into a node prompt", () => {
    const [p1, p2] = mapToPlan(sampleMap()).nodes.map((n) => n.prompt);
    assert.ok(!p1.includes('src/mul.mjs') && !p1.includes('mul(4, 5)'));
    assert.ok(!p2.includes('add(2, 3) is 5') && !p2.includes('Edit only: src/add.mjs'));
    assert.ok(p2.includes('Edit only: src/mul.mjs'));
  });
});

describe('readMap / writeJson / writeText', () => {
  it('readMap returns null when the file is missing', () => {
    assert.equal(readMap(createTempGitRepo()), null);
  });

  it('writeJson then readMap round-trips a valid map (dependsOn normalised)', () => {
    const repo = createTempGitRepo();
    writeJson(repo, '.bastion/map.json', sampleMap());
    const m = readMap(repo);
    assert.ok(m);
    assert.equal(m.nodes.length, 2);
    assert.deepEqual(m.nodes[0].dependsOn, []);
    assert.deepEqual(m.nodes[1].dependsOn, ['n1']);
  });

  it('readMap returns null for a map that fails validation, and tolerates a BOM', () => {
    const repo = createTempGitRepo();
    writeJson(repo, '.bastion/map.json', { ...sampleMap(), nodes: [] });
    assert.equal(readMap(repo), null);
    fs.writeFileSync(path.join(repo, '.bastion', 'map.json'), '﻿' + JSON.stringify(sampleMap()), 'utf8');
    assert.ok(readMap(repo));
  });

  it('writeText creates parent dirs and ends the file with exactly one newline', () => {
    const repo = createTempGitRepo();
    writeText(repo, '.bastion/maps/deep/x.md', 'hello');
    writeText(repo, '.bastion/maps/deep/y.md', 'hello\n');
    assert.equal(fs.readFileSync(path.join(repo, '.bastion/maps/deep/x.md'), 'utf8'), 'hello\n');
    assert.equal(fs.readFileSync(path.join(repo, '.bastion/maps/deep/y.md'), 'utf8'), 'hello\n');
  });
});
