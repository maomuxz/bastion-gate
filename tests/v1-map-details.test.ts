// v1.0 F9 - the map diff also reports interface and acceptance disagreements.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { runMap } from '../src/commands/map.js';
import { BastionMap, diffMapDetails } from '../src/map.js';
import { captureConsole, cleanupTempRepos } from './v04-helpers.js';
import { createRoleRepo, sampleMap } from './v1-helpers.js';

afterEach(cleanupTempRepos);

function clone(m: BastionMap): BastionMap {
  return JSON.parse(JSON.stringify(m)) as BastionMap;
}

describe('v1.0 F9 diffMapDetails', () => {
  it('returns [] for identical maps', () => {
    assert.deepEqual(diffMapDetails(sampleMap(), sampleMap()), []);
  });

  it('ignores whitespace-only interface changes (runs, newlines, edges)', () => {
    const a = sampleMap();
    const b = clone(sampleMap());
    b.nodes[0].interface = '  export   function add(a: number,\n\t b: number):   number \n';
    assert.deepEqual(diffMapDetails(a, b), []);
  });

  it('reports a real interface change as "<id>: interface differs"', () => {
    const a = sampleMap();
    const b = clone(a);
    b.nodes[1].interface = 'export function mul(a: number, b: number, c: number): number';
    assert.deepEqual(diffMapDetails(a, b), ['n2: interface differs']);
  });

  it('collapsing whitespace does not hide a change that removes whitespace between tokens', () => {
    const a = sampleMap();
    const b = clone(a);
    b.nodes[0].interface = 'export function add(a: number, b: number): number'.replace('export function', 'exportfunction');
    assert.deepEqual(diffMapDetails(a, b), ['n1: interface differs']);
  });

  it('compares acceptance as sets of trimmed sentences (order, padding and duplicates do not matter)', () => {
    const a = sampleMap();
    a.nodes[0].acceptance = ['add(2, 3) is 5', 'add(0, 0) is 0'];
    const b = clone(a);
    b.nodes[0].acceptance = ['  add(0, 0) is 0 ', 'add(2, 3) is 5', 'add(2, 3) is 5'];
    assert.deepEqual(diffMapDetails(a, b), []);
  });

  it('lists every differing acceptance sentence on both sides, with the list sizes', () => {
    const a = sampleMap();
    a.nodes[1].acceptance = ['mul(4, 5) is 20', 'only-a one', 'only-a two'];
    const b = clone(a);
    b.nodes[1].acceptance = ['mul(4, 5) is 20', 'only-b one', 'only-b two', 'only-b three'];
    const out = diffMapDetails(a, b);
    assert.equal(out.length, 1);
    const line = out[0];
    assert.match(line, /^n2: acceptance differs \(A has 3, B has 4;/);
    for (const s of ['only-a one', 'only-a two', 'only-b one', 'only-b two', 'only-b three']) {
      assert.ok(line.includes(`"${s}"`), `missing "${s}" in: ${line}`);
    }
    assert.ok(!line.includes('"mul(4, 5) is 20"'), 'shared sentences must not be listed');
    assert.ok(line.indexOf('only in A:') < line.indexOf('only in B:'));
    assert.ok(line.indexOf('"only-a two"') < line.indexOf('only in B:'));
    assert.ok(line.indexOf('"only-b one"') > line.indexOf('only in B:'));
  });

  it('emits one line per kind per node: interface line and acceptance line for the same node', () => {
    const a = sampleMap();
    const b = clone(a);
    b.nodes[0].interface = 'export const add: Function';
    b.nodes[0].acceptance = ['add(1, 1) is 2'];
    const out = diffMapDetails(a, b);
    assert.equal(out.length, 2);
    assert.equal(out.filter((l) => l.startsWith('n1: interface differs')).length, 1);
    assert.equal(out.filter((l) => l.startsWith('n1: acceptance differs')).length, 1);
  });

  it('orders output by map A node order and ignores nodes present in only one map', () => {
    const a = sampleMap();
    a.nodes = [a.nodes[1], a.nodes[0]]; // n2 first, n1 second
    const b = clone(a);
    b.nodes[0].interface = 'changed two';
    b.nodes[1].interface = 'changed one';
    // node only in A, differing text irrelevant
    const extraA = { ...clone(sampleMap()).nodes[0], id: 'zA', files: ['src/za.mjs'], testFile: 'tests/za.test.mjs' };
    a.nodes.push(extraA);
    // node only in B
    const extraB = { ...clone(sampleMap()).nodes[0], id: 'aB', files: ['src/ab.mjs'], testFile: 'tests/ab.test.mjs', interface: 'x', acceptance: ['y'] };
    b.nodes.unshift(extraB);
    assert.deepEqual(diffMapDetails(a, b), ['n2: interface differs', 'n1: interface differs']);
  });
});

describe('v1.0 F9 map-diff.md', () => {
  const read = (repo: string): string => fs.readFileSync(path.join(repo, '.bastion', 'map-diff.md'), 'utf8');

  it('adds an "Interfaces and acceptance" section (and no "No differences.") when only one interface differs', async () => {
    const planner = sampleMap();
    const blind = clone(planner);
    blind.nodes[1].interface = 'export function mul(a: number, b: number, scale?: number): number';
    const repo = createRoleRepo({ fixtures: { planner: { output: planner }, blind: { output: blind } } });
    const { result } = await captureConsole(() => runMap({ cwd: repo, requirement: 'A tiny calculator.' }));
    assert.equal(result, 0);
    const md = read(repo);
    assert.match(md, /^# Map diff/);
    assert.match(md, /^## Interfaces and acceptance$/m);
    assert.match(md, /^- n2: interface differs$/m);
    assert.doesNotMatch(md, /No differences\./);
    assert.ok(!md.includes('n1: interface differs'));
  });

  it('still says "No differences." for identical maps, with no details section', async () => {
    const planner = sampleMap();
    const repo = createRoleRepo({ fixtures: { planner: { output: planner }, blind: { output: clone(planner) } } });
    const { result } = await captureConsole(() => runMap({ cwd: repo, requirement: 'A tiny calculator.' }));
    assert.equal(result, 0);
    const md = read(repo);
    assert.match(md, /^No differences\.$/m);
    assert.doesNotMatch(md, /Interfaces and acceptance/);
  });
});
