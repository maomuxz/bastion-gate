// v1.1 - dependency scan core (src/imports.ts): which modules a test imports, which node owns them, which edges are missing.
import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BastionPlan, PlanNode } from '../src/config.js';
import { addDepsToPlan, findMissingDeps, relativeImports, resolveImport } from '../src/imports.js';
import type { MissingDep } from '../src/imports.js';
import type { BastionMap, MapNode } from '../src/map.js';

describe('v1.1 relativeImports', () => {
  it('finds static, side-effect, export-from, dynamic and require specifiers in source order', () => {
    const src = [
      `import a from './a.js';`,
      `import { b } from "../b";`,
      `import './side.js';`,
      `export * from './c.js';`,
      `export { y } from './d.js';`,
      `const e = await import('./e.js');`,
      `const f = require("./f.cjs");`,
    ].join('\n');
    assert.deepEqual(relativeImports(src), ['./a.js', '../b', './side.js', './c.js', './d.js', './e.js', './f.cjs']);
  });

  it('leaves out bare and absolute specifiers', () => {
    const src = [
      `import fs from 'node:fs';`,
      `import _ from 'lodash';`,
      `import x from '@scope/pkg';`,
      `import abs from '/abs/path.js';`,
      `const r = require('left-pad');`,
      `import ok from './ok.js';`,
    ].join('\n');
    assert.deepEqual(relativeImports(src), ['./ok.js']);
  });

  it('ignores specifiers inside // and block comments, including multi-line ones', () => {
    const src = [
      `// import './line.js';`,
      `import real from './real.js'; // import './trailing.js'`,
      `/* import './block.js' */`,
      `/**`,
      ` * const x = require('./doc.js');`,
      ` * export * from './doc2.js';`,
      ` */`,
      `import after from './after.js';`,
    ].join('\n');
    assert.deepEqual(relativeImports(src), ['./real.js', './after.js']);
  });

  it('does not mistake "//" inside a string for a comment', () => {
    const src = `const url = "http://example.com/x"; const m = require('./after-url.js');\n`;
    assert.deepEqual(relativeImports(src), ['./after-url.js']);
  });

  it('handles multi-line import lists and type-only imports', () => {
    const src = [
      `import {`,
      `  one,`,
      `  two,`,
      `} from './multi.js';`,
      `import type { T } from './types.js';`,
      `export type { U } from './utypes.js';`,
    ].join('\n');
    assert.deepEqual(relativeImports(src), ['./multi.js', './types.js', './utypes.js']);
  });

  it('lists a specifier once even when it is used several times', () => {
    const src = `import a from './a.js';\nimport('./a.js');\nconst z = require('./a.js');\nimport b from './b.js';\n`;
    assert.deepEqual(relativeImports(src), ['./a.js', './b.js']);
  });

  it('ignores non-literal arguments, plain exports and identifiers that merely end in "require"', () => {
    const src = [
      `const name = './dyn.js';`,
      `await import(name);`,
      `require(base + '/x.js');`,
      `export const k = 1;`,
      `export { k as kk };`,
      `myrequire('./nope.js');`,
      `import keep from './keep.js';`,
    ].join('\n');
    assert.deepEqual(relativeImports(src), ['./keep.js']);
  });

  it('returns [] for an empty source', () => {
    assert.deepEqual(relativeImports(''), []);
  });
});

describe('v1.1 resolveImport', () => {
  it('gives the path and its ts-family siblings for a .js specifier', () => {
    assert.deepEqual(resolveImport('src/a.ts', './b.js'), ['src/b.js', 'src/b.ts', 'src/b.tsx', 'src/b.mts']);
  });

  it('maps .mjs only to .mts', () => {
    assert.deepEqual(resolveImport('src/a.ts', './b.mjs'), ['src/b.mjs', 'src/b.mts']);
  });

  it('tries extensions and index files for an extensionless specifier, in order', () => {
    assert.deepEqual(resolveImport('src/a.ts', './b'), [
      'src/b', 'src/b.js', 'src/b.mjs', 'src/b.cjs', 'src/b.ts', 'src/b.tsx',
      'src/b/index.js', 'src/b/index.mjs', 'src/b/index.ts',
    ]);
  });

  it('gives only the path itself for other extensions', () => {
    assert.deepEqual(resolveImport('src/a.ts', './data.json'), ['src/data.json']);
    assert.deepEqual(resolveImport('src/a.ts', './b.ts'), ['src/b.ts']);
  });

  it('resolves ".." and "." segments against the importing directory', () => {
    assert.deepEqual(resolveImport('tests/a.test.ts', '../src/x.mjs'), ['src/x.mjs', 'src/x.mts']);
    assert.deepEqual(resolveImport('src/a.ts', './sub/../c.mjs'), ['src/c.mjs', 'src/c.mts']);
    assert.deepEqual(resolveImport('src/deep/a.ts', '../../top.json'), ['top.json']);
  });

  it('accepts backslashes in the importing file and resolves a file at the repo root', () => {
    assert.deepEqual(resolveImport('tests\\a.test.ts', '../src/x.mjs'), ['src/x.mjs', 'src/x.mts']);
    assert.deepEqual(resolveImport('a.ts', './x.json'), ['x.json']);
    assert.equal(resolveImport('a.ts', './x')[0], 'x');
  });

  it('gives [] when the specifier escapes the repo root', () => {
    assert.deepEqual(resolveImport('a.ts', '../x.js'), []);
    assert.deepEqual(resolveImport('src/a.ts', '../../x'), []);
    assert.deepEqual(resolveImport('src/a.ts', '../../../x.mjs'), []);
  });

  it('has no duplicate candidates', () => {
    for (const spec of ['./b.js', './b', './b.mjs']) {
      const c = resolveImport('src/a.ts', spec);
      assert.equal(new Set(c).size, c.length, spec);
    }
  });
});

function node(id: string, files: string[], dependsOn?: string[], testFile = `tests/${id}.test.mjs`): MapNode {
  return {
    id,
    title: id,
    summary: `node ${id}`,
    files,
    ...(dependsOn ? { dependsOn } : {}),
    interface: `export const ${id}: number`,
    acceptance: [`${id} works`],
    testFile,
    testCommand: `node --test ${testFile}`,
  };
}

function mapOf(...nodes: MapNode[]): BastionMap {
  return { version: 1, requirement: 'r', interfaces: 'i', nodes };
}

const imp = (...files: string[]): string => files.map((f) => `import '${f}';`).join('\n') + '\n';

describe('v1.1 findMissingDeps', () => {
  it('reports a node whose test imports a file owned by a node it does not depend on', () => {
    const map = mapOf(node('n1', ['src/add.mjs']), node('n2', ['src/mul.mjs']));
    const r = findMissingDeps(map, { 'tests/n2.test.mjs': imp('../src/add.mjs', 'node:test') });
    assert.deepEqual(r, { missing: [{ node: 'n2', needs: 'n1', via: 'src/add.mjs' }], cycles: [] });
  });

  it('reports nothing for direct or transitive dependencies, own files and unowned files', () => {
    const map = mapOf(
      node('n1', ['src/one.mjs']),
      node('n2', ['src/two.mjs'], ['n1']),
      node('n3', ['src/three.mjs'], ['n2']),
    );
    const r = findMissingDeps(map, {
      'tests/n1.test.mjs': imp('../src/one.mjs', '../src/helper.mjs'),
      'tests/n2.test.mjs': imp('../src/one.mjs', '../src/two.mjs'),
      'tests/n3.test.mjs': imp('../src/one.mjs', '../src/two.mjs', '../src/three.mjs'),
    });
    assert.deepEqual(r, { missing: [], cycles: [] });
  });

  it('gives one MissingDep per (node, needs) pair, with the first via in import order', () => {
    const map = mapOf(node('n1', ['src/a.mjs', 'src/b.mjs']), node('n2', ['src/c.mjs']));
    const r = findMissingDeps(map, { 'tests/n2.test.mjs': imp('../src/b.mjs', '../src/a.mjs', '../src/b.mjs') });
    assert.deepEqual(r.missing, [{ node: 'n2', needs: 'n1', via: 'src/b.mjs' }]);
  });

  it('resolves .js imports to .ts files and extensionless imports to index files', () => {
    const map = mapOf(node('n1', ['src/lib/index.ts', 'src/x.ts']), node('n2', ['src/y.ts']), node('n3', ['src/z.ts']));
    const r = findMissingDeps(map, {
      'tests/n2.test.mjs': imp('../src/x.js'),
      'tests/n3.test.mjs': imp('../src/lib'),
    });
    assert.deepEqual(r.missing, [
      { node: 'n2', needs: 'n1', via: 'src/x.ts' },
      { node: 'n3', needs: 'n1', via: 'src/lib/index.ts' },
    ]);
  });

  it('uses the first resolution candidate that some node owns', () => {
    const map = mapOf(node('na', ['src/x.ts']), node('nb', ['src/x.js']), node('nc', ['src/c.mjs']));
    const r = findMissingDeps(map, { 'tests/nc.test.mjs': imp('../src/x.js') });
    assert.deepEqual(r.missing, [{ node: 'nc', needs: 'nb', via: 'src/x.js' }]);
  });

  it('skips nodes whose test file is absent from `tests` and compares paths with forward slashes', () => {
    const map = mapOf(
      node('n1', ['src/one.mjs']),
      node('n2', ['src/two.mjs'], undefined, 'tests\\n2.test.mjs'),
      node('n3', ['src/three.mjs']),
    );
    const r = findMissingDeps(map, { 'tests/n2.test.mjs': imp('../src/one.mjs') });
    assert.deepEqual(r.missing, [{ node: 'n2', needs: 'n1', via: 'src/one.mjs' }]);
  });

  it('orders results by map node order, then import order', () => {
    const map = mapOf(node('a', ['src/a.mjs']), node('b', ['src/b.mjs']), node('c', ['src/c.mjs']), node('d', ['src/d.mjs']));
    const r = findMissingDeps(map, {
      'tests/b.test.mjs': imp('../src/d.mjs', '../src/c.mjs'),
      'tests/a.test.mjs': imp('../src/d.mjs'),
    });
    assert.deepEqual(r.missing.map((m) => `${m.node}->${m.needs}`), ['a->d', 'b->d', 'b->c']);
  });

  it('reports an edge that would close a direct cycle in `cycles`, not in `missing`', () => {
    const map = mapOf(node('n1', ['src/one.mjs']), node('n2', ['src/two.mjs'], ['n1']));
    const r = findMissingDeps(map, { 'tests/n1.test.mjs': imp('../src/two.mjs') });
    assert.deepEqual(r, { missing: [], cycles: [{ node: 'n1', needs: 'n2', via: 'src/two.mjs' }] });
  });

  it('detects a transitive cycle', () => {
    const map = mapOf(node('n1', ['src/one.mjs']), node('n2', ['src/two.mjs'], ['n1']), node('n3', ['src/three.mjs'], ['n2']));
    const r = findMissingDeps(map, { 'tests/n1.test.mjs': imp('../src/three.mjs') });
    assert.deepEqual(r.missing, []);
    assert.deepEqual(r.cycles, [{ node: 'n1', needs: 'n3', via: 'src/three.mjs' }]);
  });

  it('counts edges found earlier in the same call when looking for cycles', () => {
    const map = mapOf(node('a', ['src/a.mjs']), node('b', ['src/b.mjs']), node('c', ['src/c.mjs']));
    const r = findMissingDeps(map, {
      'tests/a.test.mjs': imp('../src/b.mjs'), // a -> b
      'tests/b.test.mjs': imp('../src/c.mjs'), // b -> c
      'tests/c.test.mjs': imp('../src/a.mjs'), // c -> a would close a -> b -> c -> a
    });
    assert.deepEqual(r.missing, [
      { node: 'a', needs: 'b', via: 'src/b.mjs' },
      { node: 'b', needs: 'c', via: 'src/c.mjs' },
    ]);
    assert.deepEqual(r.cycles, [{ node: 'c', needs: 'a', via: 'src/a.mjs' }]);
  });

  it('does not change the map', () => {
    const map = mapOf(node('n1', ['src/one.mjs']), node('n2', ['src/two.mjs']));
    const copy = JSON.parse(JSON.stringify(map)) as BastionMap;
    findMissingDeps(map, { 'tests/n2.test.mjs': imp('../src/one.mjs') });
    assert.deepEqual(map, copy);
  });
});

function planNode(id: string, dependsOn?: string[]): PlanNode {
  return { id, title: id, prompt: `do ${id}`, testCommand: `node --test tests/${id}.test.mjs`, tier: 1, ...(dependsOn ? { dependsOn } : {}) };
}

describe('v1.1 addDepsToPlan', () => {
  const dep = (node: string, needs: string): MissingDep => ({ node, needs, via: `src/${needs}.mjs` });

  it('appends to an existing dependsOn and creates it when absent, keeping every other field', () => {
    const plan: BastionPlan = { version: 1, nodes: [planNode('n1'), planNode('n2', ['n1']), planNode('n3')] };
    const out = addDepsToPlan(plan, [dep('n2', 'n3'), dep('n3', 'n1')]);
    assert.deepEqual(out.nodes.find((n) => n.id === 'n2')?.dependsOn, ['n1', 'n3']);
    assert.deepEqual(out.nodes.find((n) => n.id === 'n3'), { ...planNode('n3'), dependsOn: ['n1'] });
    assert.deepEqual(out.nodes.find((n) => n.id === 'n1'), planNode('n1'));
    assert.deepEqual(out.nodes.map((n) => n.id), ['n1', 'n2', 'n3']);
    assert.equal(out.version, 1);
  });

  it('leaves the input plan untouched and returns a copy', () => {
    const plan: BastionPlan = { version: 1, nodes: [planNode('n1'), planNode('n2', ['n1'])] };
    const snapshot = JSON.parse(JSON.stringify(plan)) as BastionPlan;
    const out = addDepsToPlan(plan, [dep('n1', 'n2')]);
    assert.deepEqual(plan, snapshot);
    assert.notEqual(out, plan);
    assert.deepEqual(out.nodes[0].dependsOn, ['n2']);
  });

  it('adds no duplicates, neither against existing deps nor among the additions', () => {
    const plan: BastionPlan = { version: 1, nodes: [planNode('n1'), planNode('n2', ['n1']), planNode('n3')] };
    const out = addDepsToPlan(plan, [dep('n2', 'n1'), dep('n3', 'n1'), dep('n3', 'n1'), dep('n3', 'n2')]);
    assert.deepEqual(out.nodes[1].dependsOn, ['n1']);
    assert.deepEqual(out.nodes[2].dependsOn, ['n1', 'n2']);
  });

  it('ignores unknown node ids and an empty list', () => {
    const plan: BastionPlan = { version: 1, nodes: [planNode('n1'), planNode('n2')] };
    assert.deepEqual(addDepsToPlan(plan, [dep('ghost', 'n1')]), plan);
    assert.deepEqual(addDepsToPlan(plan, []), plan);
  });
});
