// v1.0 - `bastion map` command, map/split helpers and runRole.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { runMap } from '../src/commands/map.js';
import {
  BastionMap,
  diffMaps,
  mapToPlan,
  renderAcceptance,
  renderInterfaces,
  renderMapDiff,
  validateMap,
} from '../src/map.js';
import { runRole } from '../src/roles.js';
import { MAX_MAP_DEPTH, mapDepth, splitNode } from '../src/split.js';
import { captureConsole, cleanupTempRepos, readJson, writeRepoFile } from './v04-helpers.js';
import { createRoleRepo, readRoleCalls, RoleFixtures, sampleMap, setFixtures } from './v1-helpers.js';

afterEach(cleanupTempRepos);

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const exists = (repo: string, rel: string): boolean => fs.existsSync(path.join(repo, rel));
const read = (repo: string, rel: string): string => fs.readFileSync(path.join(repo, rel), 'utf8');
const REQ = 'Build a tiny calculator CLI with add and mul.';

/** Blind map that differs from sampleMap: n2 has no dependency, owns an extra file, plus an extra node n3. */
function blindMap(): BastionMap {
  const m = clone(sampleMap());
  m.nodes[1].dependsOn = [];
  m.nodes[1].files.push('src/extra.mjs');
  m.nodes.push({
    id: 'n3', title: 'Div', summary: 'Export div.', files: ['src/div.mjs'], interface: 'export function div(a: number, b: number): number',
    acceptance: ['div(6, 3) is 2'], testFile: 'tests/div.test.mjs', testCommand: 'node --test tests/div.test.mjs',
  });
  return m;
}

function plannerMap(): BastionMap {
  const m = clone(sampleMap());
  m.interfaces = 'PLANNER-SECRET-MARKER shared contract.';
  return m;
}

function fixtures(planner: unknown, blind: unknown): RoleFixtures {
  return { planner: { output: planner }, blind: { output: blind } };
}

const INVALID = { version: 1, requirement: 'x', interfaces: '', nodes: [] };

describe('v1.0 bastion map', () => {
  it('writes every output from planner + blind maps and calls both roles with separate prompts', async () => {
    const repo = createRoleRepo({ fixtures: fixtures(plannerMap(), blindMap()) });
    const { result } = await captureConsole(() => runMap({ cwd: repo, requirement: REQ }));
    assert.equal(result, 0);

    assert.match(read(repo, '.bastion/requirement.md'), /tiny calculator CLI/);
    assert.deepEqual(readJson<BastionMap>(path.join(repo, '.bastion/maps/map-a.json')).interfaces, 'PLANNER-SECRET-MARKER shared contract.');
    assert.equal(readJson<BastionMap>(path.join(repo, '.bastion/maps/map-b.json')).nodes.length, 3);

    const map = readJson<BastionMap>(path.join(repo, '.bastion/map.json'));
    assert.equal(map.interfaces, 'PLANNER-SECRET-MARKER shared contract.');
    assert.deepEqual(map.nodes.map((n) => n.id), ['n1', 'n2']);
    assert.deepEqual(map.nodes[0].dependsOn, []); // normalised

    const diff = read(repo, '.bastion/map-diff.md');
    assert.ok(diff.startsWith('# Map diff'));
    assert.match(diff, /Only in blind map/);
    assert.match(diff, /n3/);
    assert.match(diff, /Dependencies/);
    assert.match(diff, /src\/extra\.mjs/);

    assert.match(read(repo, '.bastion/interfaces.md'), /## n1 Add/);
    assert.match(read(repo, '.bastion/acceptance.md'), /- mul\(4, 5\) is 20/);

    const plan = readJson<{ version: number; nodes: Array<{ id: string; dependsOn?: string[]; testCommand?: string; tier?: number; prompt: string }> }>(
      path.join(repo, '.bastion/plan.json')
    );
    assert.equal(plan.version, 1);
    assert.deepEqual(plan.nodes.map((n) => n.id), ['n1', 'n2']);
    assert.deepEqual(plan.nodes[1].dependsOn, ['n1']);
    assert.equal(plan.nodes[1].testCommand, 'node --test tests/mul.test.mjs');
    assert.equal(plan.nodes[0].tier, 1);
    assert.match(plan.nodes[1].prompt, /Edit only: src\/mul\.mjs/);

    const calls = readRoleCalls(repo);
    assert.equal(calls.length, 2);
    const a = calls.find((c) => c.role === 'planner');
    const b = calls.find((c) => c.role === 'blind');
    assert.ok(a && b, 'both planner and blind must be called');
    for (const c of [a, b]) {
      assert.match(c.prompt, /tiny calculator CLI/);
      assert.match(c.prompt, /role-fixtures\.json/, 'top-level file list');
      assert.match(c.prompt, /scripts/, 'top-level file list');
      assert.match(c.prompt, /testCommand/, 'BastionMap schema');
      assert.match(c.prompt, /dependsOn/, 'BastionMap schema');
    }
    assert.ok(!b.prompt.includes('PLANNER-SECRET-MARKER'));
    assert.ok(!b.prompt.includes('Add'), 'blind prompt must not leak planner node titles');
    assert.deepEqual(calls.map((c) => c.label).sort(), ['map-a', 'map-b']);
  });

  it('runs planner and blind in parallel', async () => {
    const script = [
      `import * as fs from 'node:fs';`,
      `const home = process.env.BASTION_HOME;`,
      `const role = process.env.BASTION_ROLE;`,
      `fs.writeFileSync(home + '/par-' + role, '1');`,
      `const end = Date.now() + 15000;`,
      `while (Date.now() < end && !(fs.existsSync(home + '/par-planner') && fs.existsSync(home + '/par-blind'))) await new Promise((r) => setTimeout(r, 50));`,
      `if (!(fs.existsSync(home + '/par-planner') && fs.existsSync(home + '/par-blind'))) process.exit(3);`,
      `fs.writeFileSync(process.env.BASTION_OUTPUT, fs.readFileSync(home + '/par-map.json', 'utf8'));`,
    ].join('\n');
    const repo = createRoleRepo({
      fixtures: {},
      files: { 'scripts/par.mjs': script, 'par-map.json': JSON.stringify(sampleMap()) },
      configPatch: { roles: { planner: 'node scripts/par.mjs', blind: 'node scripts/par.mjs' } },
    });
    const { result } = await captureConsole(() => runMap({ cwd: repo, requirement: REQ }));
    assert.equal(result, 0);
    assert.ok(exists(repo, '.bastion/maps/map-b.json'));
  });

  it('identical maps give "No differences."', async () => {
    const repo = createRoleRepo({ fixtures: fixtures(sampleMap(), sampleMap()) });
    const { result } = await captureConsole(() => runMap({ cwd: repo, requirement: REQ }));
    assert.equal(result, 0);
    assert.match(read(repo, '.bastion/map-diff.md'), /No differences\./);
  });

  it('removes a stale approval.json', async () => {
    const repo = createRoleRepo({ fixtures: fixtures(sampleMap(), sampleMap()) });
    writeRepoFile(repo, '.bastion/approval.json', '{"approved":true}');
    const { result } = await captureConsole(() => runMap({ cwd: repo, requirement: REQ }));
    assert.equal(result, 0);
    assert.equal(exists(repo, '.bastion/approval.json'), false);
  });

  it('invalid planner map -> 1, prints errors, writes no outputs and keeps approval', async () => {
    const repo = createRoleRepo({ fixtures: fixtures(INVALID, sampleMap()) });
    writeRepoFile(repo, '.bastion/approval.json', '{"approved":true}');
    const { result, out, err } = await captureConsole(() => runMap({ cwd: repo, requirement: REQ }));
    assert.equal(result, 1);
    const printed = out + '\n' + err;
    for (const e of (validateMap(INVALID) as { errors: string[] }).errors) assert.ok(printed.includes(e), `missing error: ${e}`);
    for (const rel of ['map.json', 'map-diff.md', 'interfaces.md', 'acceptance.md', 'plan.json']) {
      assert.equal(exists(repo, `.bastion/${rel}`), false, rel);
    }
    assert.ok(exists(repo, '.bastion/approval.json'));
  });

  it('invalid blind map -> still 0, diff says blind map was invalid and lists its errors', async () => {
    const repo = createRoleRepo({ fixtures: fixtures(sampleMap(), INVALID) });
    const { result } = await captureConsole(() => runMap({ cwd: repo, requirement: REQ }));
    assert.equal(result, 0);
    assert.equal(readJson<BastionMap>(path.join(repo, '.bastion/map.json')).nodes.length, 2);
    const diff = read(repo, '.bastion/map-diff.md');
    assert.match(diff, /blind map[^\n]*invalid|invalid[^\n]*blind map/i);
    for (const e of (validateMap(INVALID) as { errors: string[] }).errors) assert.ok(diff.includes(e), `missing error: ${e}`);
    assert.ok(exists(repo, '.bastion/plan.json'));
  });

  it('blind that writes no output file is treated as invalid, not fatal', async () => {
    const repo = createRoleRepo({ fixtures: { planner: { output: sampleMap() }, blind: {} } });
    const { result } = await captureConsole(() => runMap({ cwd: repo, requirement: REQ }));
    assert.equal(result, 0);
    assert.match(read(repo, '.bastion/map-diff.md'), /invalid/i);
  });

  it('planner that writes no output -> 1', async () => {
    const repo = createRoleRepo({ fixtures: { planner: {}, blind: { output: sampleMap() } } });
    const { result } = await captureConsole(() => runMap({ cwd: repo, requirement: REQ }));
    assert.equal(result, 1);
    assert.equal(exists(repo, '.bastion/map.json'), false);
  });

  it('no planner command -> 1 and no role is called', async () => {
    const repo = createRoleRepo({ fixtures: fixtures(sampleMap(), sampleMap()) });
    const cfgPath = path.join(repo, '.bastion', 'config.json');
    const cfg = readJson<Record<string, unknown>>(cfgPath);
    delete cfg.agentCommand;
    cfg.roles = {};
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));
    const { result } = await captureConsole(() => runMap({ cwd: repo, requirement: REQ }));
    assert.equal(result, 1);
    assert.equal(readRoleCalls(repo).length, 0);
    assert.equal(exists(repo, '.bastion/map.json'), false);
  });

  it('blind falls back to the planner command when no blind role is configured', async () => {
    const repo = createRoleRepo({ fixtures: fixtures(sampleMap(), sampleMap()), configPatch: { roles: { planner: 'node scripts/role.mjs' } } });
    const cfgPath = path.join(repo, '.bastion', 'config.json');
    const cfg = readJson<Record<string, unknown>>(cfgPath);
    delete cfg.agentCommand;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));
    const { result } = await captureConsole(() => runMap({ cwd: repo, requirement: REQ }));
    assert.equal(result, 0);
    assert.equal(readRoleCalls(repo).length, 2);
    assert.ok(exists(repo, '.bastion/maps/map-b.json'));
  });

  it('requires a requirement unless a parent is given', async () => {
    const repo = createRoleRepo({ fixtures: fixtures(sampleMap(), sampleMap()) });
    const { result } = await captureConsole(() => runMap({ cwd: repo }));
    assert.equal(result, 1);
    assert.equal(readRoleCalls(repo).length, 0);
  });
});

function subMap(): BastionMap {
  return {
    version: 1,
    requirement: 'Split Mul',
    interfaces: 'SUB-INTERFACES shared by the parts.',
    nodes: [
      { id: 'x', title: 'Loop', summary: 'Loop part.', files: ['src/mul/loop.mjs'], interface: 'export function loop(): void', acceptance: ['loops'], testFile: 'tests/mul-loop.test.mjs', testCommand: 'node --test tests/mul-loop.test.mjs' },
      { id: 'y', title: 'Wrap', summary: 'Wrap part.', files: ['src/mul/wrap.mjs'], dependsOn: ['x'], interface: 'export function wrap(): void', acceptance: ['wraps'], testFile: 'tests/mul-wrap.test.mjs', testCommand: 'node --test tests/mul-wrap.test.mjs' },
    ],
  };
}

describe('v1.0 bastion map --node', () => {
  async function mappedRepo(): Promise<string> {
    const repo = createRoleRepo({ fixtures: fixtures(sampleMap(), sampleMap()) });
    await captureConsole(() => runMap({ cwd: repo, requirement: REQ }));
    return repo;
  }

  it('splits a node: asks both roles, rewrites map.json/plan.json/interfaces/acceptance, drops approval', async () => {
    const repo = await mappedRepo();
    writeRepoFile(repo, '.bastion/approval.json', '{"approved":true}');
    const before = readRoleCalls(repo).length;
    setFixtures(repo, fixtures(subMap(), subMap()));
    const { result } = await captureConsole(() => runMap({ cwd: repo, parent: 'n2' }));
    assert.equal(result, 0);

    const calls = readRoleCalls(repo).slice(before);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map((c) => c.role).sort(), ['blind', 'planner']);
    for (const c of calls) {
      assert.match(c.prompt, /Mul/);
      assert.match(c.prompt, /built on add/);
      assert.match(c.prompt, /export function mul\(a: number, b: number\): number/);
      assert.match(c.prompt, /mul\(4, 5\) is 20/);
    }

    const map = readJson<BastionMap>(path.join(repo, '.bastion/map.json'));
    assert.deepEqual(map.nodes.map((n) => n.id), ['n1', 'n2.x', 'n2.y']);
    assert.deepEqual(map.nodes[1].dependsOn, ['n1']); // inherits parent's dependsOn
    assert.deepEqual(map.nodes[2].dependsOn, ['n2.x']);
    assert.match(map.interfaces, /## n2/);
    assert.match(map.interfaces, /SUB-INTERFACES/);

    const plan = readJson<{ nodes: Array<{ id: string }> }>(path.join(repo, '.bastion/plan.json'));
    assert.deepEqual(plan.nodes.map((n) => n.id), ['n1', 'n2.x', 'n2.y']);
    assert.match(read(repo, '.bastion/interfaces.md'), /## n2\.y Wrap/);
    assert.match(read(repo, '.bastion/acceptance.md'), /- wraps/);
    assert.equal(exists(repo, '.bastion/approval.json'), false);
  });

  it('rewires dependents of the split node onto every sub node', async () => {
    const repo = await mappedRepo();
    setFixtures(repo, fixtures(subMap(), subMap()));
    // n1 has a dependent (n2), so splitting n1 rewires n2.
    const sub = subMap();
    sub.nodes[0].files = ['src/add/a.mjs'];
    sub.nodes[1].files = ['src/add/b.mjs'];
    setFixtures(repo, fixtures(sub, sub));
    const { result } = await captureConsole(() => runMap({ cwd: repo, parent: 'n1' }));
    assert.equal(result, 0);
    const map = readJson<BastionMap>(path.join(repo, '.bastion/map.json'));
    assert.deepEqual(map.nodes.map((n) => n.id), ['n1.x', 'n1.y', 'n2']);
    assert.deepEqual(map.nodes[2].dependsOn, ['n1.x', 'n1.y']);
  });

  it('invalid sub-map -> 1 and map.json is unchanged', async () => {
    const repo = await mappedRepo();
    const before = read(repo, '.bastion/map.json');
    setFixtures(repo, fixtures(INVALID, subMap()));
    const { result } = await captureConsole(() => runMap({ cwd: repo, parent: 'n2' }));
    assert.equal(result, 1);
    assert.equal(read(repo, '.bastion/map.json'), before);
  });

  it('unknown parent -> 1; missing map.json -> 1', async () => {
    const repo = await mappedRepo();
    setFixtures(repo, fixtures(subMap(), subMap()));
    assert.equal((await captureConsole(() => runMap({ cwd: repo, parent: 'nope' }))).result, 1);
    fs.rmSync(path.join(repo, '.bastion/map.json'));
    assert.equal((await captureConsole(() => runMap({ cwd: repo, parent: 'n2' }))).result, 1);
  });
});

describe('v1.0 map.ts helpers', () => {
  it('validateMap accepts the sample map and normalises dependsOn', () => {
    const v = validateMap(sampleMap());
    assert.equal(v.ok, true);
    if (v.ok) {
      assert.deepEqual(v.map.nodes[0].dependsOn, []);
      assert.deepEqual(v.map.nodes[1].dependsOn, ['n1']);
    }
  });

  it('validateMap rejects each broken rule with at least one error', () => {
    const mutations: Record<string, (m: BastionMap) => unknown> = {
      'wrong version': (m) => ({ ...m, version: 2 }),
      'empty nodes': (m) => ({ ...m, nodes: [] }),
      'nodes not array': (m) => ({ ...m, nodes: 'x' }),
      'requirement not string': (m) => ({ ...m, requirement: 5 }),
      'interfaces missing': (m) => { const c: Record<string, unknown> = { ...m }; delete c.interfaces; return c; },
      'duplicate ids': (m) => { m.nodes[1].id = 'n1'; return m; },
      'unknown dependency': (m) => { m.nodes[1].dependsOn = ['ghost']; return m; },
      'cycle': (m) => { m.nodes[0].dependsOn = ['n2']; return m; },
      'self cycle': (m) => { m.nodes[0].dependsOn = ['n1']; return m; },
      'shared file': (m) => { m.nodes[1].files = ['src/add.mjs']; return m; },
      'testFile in files': (m) => { m.nodes[0].files.push('tests/mul.test.mjs'); return m; },
      'own testFile in files': (m) => { m.nodes[0].files = ['tests/add.test.mjs']; return m; },
      'empty files': (m) => { m.nodes[0].files = []; return m; },
      'empty acceptance': (m) => { m.nodes[0].acceptance = []; return m; },
      'empty title': (m) => { m.nodes[0].title = ''; return m; },
      'empty testCommand': (m) => { m.nodes[0].testCommand = ''; return m; },
      'not an object': () => 'nope',
      'null': () => null,
    };
    for (const [name, mutate] of Object.entries(mutations)) {
      const v = validateMap(mutate(clone(sampleMap())));
      assert.equal(v.ok, false, name);
      if (!v.ok) assert.ok(v.errors.length > 0 && v.errors.every((e) => typeof e === 'string' && e.length > 0), name);
    }
  });

  it('diffMaps reports only-in, dependency and ownership differences', () => {
    const d = diffMaps(sampleMap(), blindMap());
    assert.deepEqual(d.onlyInA, []);
    assert.deepEqual(d.onlyInB, ['n3']);
    assert.equal(d.dependencyDiffs.length, 1);
    assert.match(d.dependencyDiffs[0], /^n2: A depends on \[n1\] \/ B depends on \[\]/);
    assert.ok(d.ownershipDiffs.some((l) => l.includes('src/extra.mjs')));
    assert.ok(d.ownershipDiffs.some((l) => l.includes('src/div.mjs')));
    const rev = diffMaps(blindMap(), sampleMap());
    assert.deepEqual(rev.onlyInA, ['n3']);
    assert.deepEqual(rev.onlyInB, []);
    assert.deepEqual(diffMaps(sampleMap(), sampleMap()), { onlyInA: [], onlyInB: [], dependencyDiffs: [], ownershipDiffs: [] });
  });

  it('diffMaps reports a file owned by different nodes', () => {
    const b = clone(sampleMap());
    b.nodes[0].files = ['src/mul.mjs'];
    b.nodes[1].files = ['src/add.mjs'];
    const d = diffMaps(sampleMap(), b);
    assert.equal(d.ownershipDiffs.length, 2);
  });

  it('renderMapDiff: empty -> No differences.; otherwise one section per non-empty list', () => {
    const none = renderMapDiff({ onlyInA: [], onlyInB: [], dependencyDiffs: [], ownershipDiffs: [] });
    assert.ok(none.startsWith('# Map diff'));
    assert.match(none, /^No differences\.$/m);
    const some = renderMapDiff({ onlyInA: ['n9'], onlyInB: [], dependencyDiffs: ['n2: A depends on [n1] / B depends on []'], ownershipDiffs: [] });
    assert.match(some, /^## Only in planner map$/m);
    assert.match(some, /^- n9$/m);
    assert.match(some, /^## Dependencies$/m);
    assert.match(some, /^- n2: A depends on/m);
    assert.doesNotMatch(some, /Only in blind map|File ownership|No differences\./);
  });

  it('renderInterfaces and renderAcceptance follow the documented layout', () => {
    const i = renderInterfaces(sampleMap());
    assert.ok(i.startsWith('# Interfaces'));
    assert.ok(i.includes('ES modules under src/'));
    assert.match(i, /^## n1 Add$/m);
    assert.match(i, /^## n2 Mul$/m);
    assert.ok(i.includes('export function mul(a: number, b: number): number'));
    const a = renderAcceptance(sampleMap());
    assert.ok(a.startsWith('# Acceptance'));
    assert.match(a, /^## n1 Add$/m);
    assert.match(a, /^- add\(2, 3\) is 5$/m);
    assert.match(a, /^- mul\(4, 5\) is 20$/m);
  });

  it('mapToPlan builds one tier-1 node per map node with the documented prompt lines', () => {
    const m = clone(sampleMap());
    m.nodes[1].files = ['src/mul.mjs', 'src/mul-helpers.mjs'];
    m.nodes[1].acceptance = ['mul(4, 5) is 20', 'mul(0, 5) is 0'];
    const plan = mapToPlan(m);
    assert.equal(plan.version, 1);
    assert.equal(plan.nodes.length, 2);
    const n2 = plan.nodes[1];
    assert.equal(n2.id, 'n2');
    assert.equal(n2.title, 'Mul');
    assert.deepEqual(n2.dependsOn, ['n1']);
    assert.equal(n2.testCommand, 'node --test tests/mul.test.mjs');
    assert.equal(n2.tier, 1);
    assert.ok(n2.prompt.includes('Export mul(a, b) returning the product, built on add.'));
    assert.ok(n2.prompt.includes('Edit only: src/mul.mjs, src/mul-helpers.mjs'));
    assert.ok(n2.prompt.includes('export function mul(a: number, b: number): number'));
    assert.ok(n2.prompt.includes('mul(4, 5) is 20') && n2.prompt.includes('mul(0, 5) is 0'));
    assert.ok(n2.prompt.includes('Locked tests: tests/mul.test.mjs'));
    assert.ok(n2.prompt.includes('Your node test command: node --test tests/mul.test.mjs'));
    assert.deepEqual(plan.nodes[0].dependsOn ?? [], []);
  });
});

describe('v1.0 split.ts', () => {
  it('mapDepth counts dot-separated segments; MAX_MAP_DEPTH is 3', () => {
    assert.equal(mapDepth('a'), 1);
    assert.equal(mapDepth('a.b'), 2);
    assert.equal(mapDepth('a.b.c'), 3);
    assert.equal(MAX_MAP_DEPTH, 3);
  });

  function threeNodes(): BastionMap {
    const m = clone(sampleMap());
    m.nodes.push({
      id: 'n3', title: 'Tail', summary: 'Tail.', files: ['src/tail.mjs'], dependsOn: ['n2'], interface: 'tail()',
      acceptance: ['tail works'], testFile: 'tests/tail.test.mjs', testCommand: 'node --test tests/tail.test.mjs',
    });
    return m;
  }

  it('splitNode replaces the parent in place, prefixes ids, inherits and rewires dependencies', () => {
    const base = threeNodes();
    const snapshot = clone(base);
    const sub = subMap();
    const subSnapshot = clone(sub);
    const out = splitNode(base, 'n2', sub);
    assert.deepEqual(out.nodes.map((n) => n.id), ['n1', 'n2.x', 'n2.y', 'n3']);
    assert.deepEqual(out.nodes[1].dependsOn, ['n1']);
    assert.deepEqual(out.nodes[2].dependsOn, ['n2.x']);
    assert.deepEqual(out.nodes[3].dependsOn, ['n2.x', 'n2.y']);
    assert.deepEqual(out.nodes[0], base.nodes[0]);
    assert.ok(out.interfaces.startsWith(base.interfaces));
    assert.match(out.interfaces, /^## n2$/m);
    assert.ok(out.interfaces.includes('SUB-INTERFACES'));
    assert.deepEqual(base, snapshot, 'input map mutated');
    assert.deepEqual(sub, subSnapshot, 'sub map mutated');
    assert.equal(validateMap(out).ok, true);
  });

  it('splitNode throws on unknown parent, empty sub, and depth overflow', () => {
    assert.throws(() => splitNode(threeNodes(), 'zzz', subMap()));
    assert.throws(() => splitNode(threeNodes(), 'n2', { ...subMap(), nodes: [] }));
    const deep = clone(sampleMap());
    deep.nodes[0].id = 'a.b.c';
    deep.nodes[1].dependsOn = ['a.b.c'];
    assert.throws(() => splitNode(deep, 'a.b.c', subMap()));
    const ok = clone(sampleMap());
    ok.nodes[0].id = 'a.b';
    ok.nodes[1].dependsOn = ['a.b'];
    const out = splitNode(ok, 'a.b', subMap());
    assert.deepEqual(out.nodes.map((n) => n.id), ['a.b.x', 'a.b.y', 'n2']);
  });
});

describe('v1.0 runRole', () => {
  it('passes role env, prompt and output placeholders, and returns exit code and output', async () => {
    const repo = createRoleRepo({ fixtures: {} });
    writeRepoFile(
      repo,
      'scripts/echo.mjs',
      [
        `import * as fs from 'node:fs';`,
        `fs.writeFileSync(process.argv[2], [process.env.BASTION_ROLE, process.env.BASTION_NODE_ID, process.env.BASTION_HOME, fs.readFileSync(process.env.BASTION_PROMPT_FILE, 'utf8')].join('|'));`,
        `console.log('hello-from-role');`,
        `process.exit(7);`,
      ].join('\n')
    );
    const outputPath = path.join(repo, '.bastion', 'maps', 'x', 'out.json');
    const r = await runRole('node scripts/echo.mjs {output}', 'qa', { prompt: 'PROMPT-BODY', cwd: repo, repoRoot: repo, label: 'lbl', outputPath });
    assert.equal(r.exitCode, 7);
    assert.equal(r.timedOut, false);
    assert.match(r.output, /hello-from-role/);
    assert.equal(fs.readFileSync(outputPath, 'utf8'), `qa|lbl|${repo}|PROMPT-BODY`);
    assert.ok(fs.existsSync(path.join(repo, '.bastion', 'logs', 'lbl.log')));
  });

  it('times out slow commands with exit code 124', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bastion-role-'));
    try {
      const r = await runRole('node -e "setTimeout(()=>{},20000)"', 'worker', { prompt: 'p', cwd: tmp, repoRoot: tmp, label: 'slow', timeoutMs: 500 });
      assert.equal(r.timedOut, true);
      assert.equal(r.exitCode, 124);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
