// v1.1 village tier - `bastion contract`: parseContractOutput and runContract (one role call replaces map + scaffold).
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { parseContractOutput, runContract } from '../src/commands/contract.js';
import type { ContractOutput } from '../src/commands/contract.js';
import { isMapApproved } from '../src/commands/review.js';
import { mapToPlan, readMap, renderAcceptance, renderInterfaces, validateMap } from '../src/map.js';
import type { BastionMap } from '../src/map.js';
import { captureConsole, cleanupTempRepos, createTempGitRepo, git, readJson, writeRepoFile } from './v04-helpers.js';
import { createRoleRepo, readRoleCalls, SAMPLE_FILES } from './v1-helpers.js';
import type { RoleFixture } from './v1-helpers.js';

afterEach(cleanupTempRepos);

const REQUIREMENT = 'Build a tiny calculator.\nIt exports add(a, b) and mul(a, b); "add" & \'mul\' work on numbers — 日本語 ok.';
const TEST_FILE = 'tests/calc.test.mjs';
const TEST_COMMAND = 'node --test tests/calc.test.mjs';
const STUBS: Record<string, string> = { ...SAMPLE_FILES.stubs };
const STUB_PATHS = Object.keys(STUBS);

function goodOutput(over: Partial<ContractOutput> = {}): ContractOutput {
  return {
    files: STUB_PATHS,
    testFile: TEST_FILE,
    interface: '- `add(a, b): number` in src/add.mjs\n- `mul(a, b): number` in src/mul.mjs',
    acceptance: ['add(2, 3) is 5', 'mul(4, 5) is 20'],
    ...over,
  };
}

function contractRepo(contract: RoleFixture, extraFiles: Record<string, string> = {}): string {
  return createRoleRepo({
    fixtures: { planner: { byLabel: { contract } } },
    files: { 'README.md': '# demo\n', ...extraFiles },
    testCommand: TEST_COMMAND,
  });
}

function okRepo(extraFiles: Record<string, string> = {}): string {
  return contractRepo({ files: STUBS, output: goodOutput() }, extraFiles);
}

const head = (repo: string): string => git(['rev-parse', 'HEAD'], repo);
const run = (repo: string, requirement = REQUIREMENT) => captureConsole(() => runContract({ cwd: repo, requirement }));

/** A failed contract leaves the history alone and writes no map / approval. */
function assertFailedCleanly(repo: string, before: string): void {
  assert.equal(head(repo), before, 'no commit on failure');
  assert.equal(fs.existsSync(path.join(repo, '.bastion', 'map.json')), false, 'no map.json on failure');
  assert.equal(fs.existsSync(path.join(repo, '.bastion', 'approval.json')), false, 'no approval on failure');
  assert.equal(isMapApproved(repo), false);
}

// ---------------------------------------------------------------- parseContractOutput

describe('v1.1 parseContractOutput', () => {
  it('returns the cleaned value for a valid output', () => {
    const out = parseContractOutput(goodOutput());
    assert.ok(out);
    assert.deepEqual(out.files, STUB_PATHS);
    assert.equal(out.testFile, TEST_FILE);
    assert.equal(out.interface, goodOutput().interface);
    assert.deepEqual(out.acceptance, goodOutput().acceptance);
  });

  it('normalises backslashes in files and testFile to "/"', () => {
    const out = parseContractOutput(goodOutput({ files: ['src\\lib\\add.mjs', 'src/mul.mjs'], testFile: 'tests\\unit\\calc.test.mjs' }));
    assert.ok(out);
    assert.deepEqual(out.files, ['src/lib/add.mjs', 'src/mul.mjs']);
    assert.equal(out.testFile, 'tests/unit/calc.test.mjs');
  });

  it('rejects anything that is not an object', () => {
    for (const raw of [null, undefined, 'x', 42, true, [], [goodOutput()]]) assert.equal(parseContractOutput(raw), null, String(raw));
  });

  it('rejects a bad `files`', () => {
    const base = goodOutput();
    for (const files of [[], 'src/a.mjs', undefined, null, [''], ['src/a.mjs', ''], ['src/a.mjs', 7], [null]]) {
      assert.equal(parseContractOutput({ ...base, files }), null, JSON.stringify(files));
    }
    const { files: _omit, ...noFiles } = base;
    assert.equal(parseContractOutput(noFiles), null, 'files missing');
  });

  it('rejects a bad `testFile`, including one that is in `files` (also after backslash normalisation)', () => {
    const base = goodOutput();
    for (const testFile of ['', undefined, null, 5, ['tests/a.mjs']]) {
      assert.equal(parseContractOutput({ ...base, testFile }), null, JSON.stringify(testFile));
    }
    assert.equal(parseContractOutput({ ...base, files: ['src/add.mjs', 'src/mul.mjs'], testFile: 'src/add.mjs' }), null);
    assert.equal(parseContractOutput({ ...base, files: ['src/add.mjs'], testFile: 'src\\add.mjs' }), null);
    assert.equal(parseContractOutput({ ...base, files: ['src\\add.mjs'], testFile: 'src/add.mjs' }), null);
  });

  it('rejects a blank `interface` (whitespace only counts as blank)', () => {
    const base = goodOutput();
    for (const iface of ['', '   ', '\n\t \n', undefined, null, 3]) {
      assert.equal(parseContractOutput({ ...base, interface: iface }), null, JSON.stringify(iface));
    }
  });

  it('rejects a bad `acceptance`', () => {
    const base = goodOutput();
    for (const acceptance of [[], 'add works', undefined, null, [''], ['ok', ''], ['ok', 1]]) {
      assert.equal(parseContractOutput({ ...base, acceptance }), null, JSON.stringify(acceptance));
    }
  });
});

// ---------------------------------------------------------------- runContract: success

describe('v1.1 runContract success', () => {
  it('step 1: writes the requirement verbatim to .bastion/requirement.md', async () => {
    const repo = okRepo();
    const { result, err } = await run(repo);
    assert.equal(result, 0, err);
    assert.equal(fs.readFileSync(path.join(repo, '.bastion', 'requirement.md'), 'utf8'), REQUIREMENT);
  });

  it('step 2: calls the planner role once, labelled "contract", with the prompt the contract describes', async () => {
    const repo = okRepo();
    const { result, err } = await run(repo);
    assert.equal(result, 0, err);
    const calls = readRoleCalls(repo);
    assert.equal(calls.length, 1, 'exactly one role call');
    assert.equal(calls[0].role, 'planner');
    assert.equal(calls[0].label, 'contract');
    const p = calls[0].prompt;
    assert.ok(p.includes(REQUIREMENT), 'requirement verbatim');
    // top-level file names of the repo
    for (const name of ['README.md', 'scripts', 'role-fixtures.json']) assert.ok(p.includes(name), `lists top-level "${name}"`);
    // rules for the role
    assert.match(p, /stub/i);
    assert.match(p, /public/i);
    assert.match(p, /do not design[^.\n]*internal|internal[^.\n]*(do not|don't|never)|(do not|don't|never)[^.\n]*internal/i, 'forbids internal design');
    assert.match(p, /do not write (any )?tests?|don't write (any )?tests?|never write (any )?tests?|no tests/i, 'forbids tests');
    assert.match(p, /do not commit|don't commit|never commit|no commit/i, 'forbids commit');
    assert.match(p, /placeholder/i);
    // the JSON shape of ContractOutput
    for (const key of ['files', 'testFile', 'interface', 'acceptance']) assert.ok(p.includes(key), `shows the "${key}" field`);
  });

  it('step 3: files under .bastion/ and a stray-looking untracked file inside .bastion are tolerated', async () => {
    const repo = contractRepo({ files: { ...STUBS, '.bastion/notes.md': 'scratch\n', '.bastion/maps/extra.json': '{}' }, output: goodOutput() });
    const { result, err } = await run(repo);
    assert.equal(result, 0, err);
    const committed = git(['show', '--name-only', '--format=', 'HEAD'], repo).split(/\r?\n/).filter(Boolean);
    assert.equal(committed.some((f) => f.startsWith('.bastion/')), false, 'scratch under .bastion is not committed');
  });

  it('step 4: builds the exact one-node map, and readMap accepts it', async () => {
    const repo = okRepo();
    const out = goodOutput();
    const { result, err } = await run(repo);
    assert.equal(result, 0, err);

    const raw = readJson<BastionMap>(path.join(repo, '.bastion', 'map.json'));
    assert.equal(raw.version, 1);
    assert.equal(raw.requirement, REQUIREMENT);
    assert.equal(raw.interfaces, out.interface);
    assert.equal(raw.nodes.length, 1);
    const n = raw.nodes[0];
    assert.equal(n.id, 'village');
    assert.equal(n.title, 'Whole project');
    assert.equal(n.summary, 'Implement the whole requirement in one session.');
    assert.deepEqual(n.files, out.files);
    assert.equal(n.interface, out.interface);
    assert.deepEqual(n.acceptance, out.acceptance);
    assert.equal(n.testFile, TEST_FILE);
    assert.equal(n.testCommand, TEST_COMMAND, 'config.testCommand');
    assert.equal(validateMap(raw).ok, true);

    const map = readMap(repo);
    assert.ok(map, 'readMap accepts it');
    assert.equal(map.nodes.length, 1);
    assert.equal(map.nodes[0].id, 'village');
    assert.deepEqual(map.nodes[0].dependsOn ?? [], []);
  });

  it('step 4: writes interfaces.md, acceptance.md, plan.json and the exact map-diff.md text', async () => {
    const repo = okRepo();
    const { result, err } = await run(repo);
    assert.equal(result, 0, err);
    const map = readMap(repo);
    assert.ok(map);
    const b = path.join(repo, '.bastion');
    assert.equal(fs.readFileSync(path.join(b, 'interfaces.md'), 'utf8'), renderInterfaces(map));
    assert.equal(fs.readFileSync(path.join(b, 'acceptance.md'), 'utf8'), renderAcceptance(map));
    assert.deepEqual(readJson(path.join(b, 'plan.json')), JSON.parse(JSON.stringify(mapToPlan(map))));
    assert.equal(fs.readFileSync(path.join(b, 'map-diff.md'), 'utf8'), '# Map diff\n\nSingle contract (village tier): no second map.\n');
  });

  it('step 5: approves the map without a human stop (by: "village-tier", sha of map.json)', async () => {
    const repo = okRepo();
    assert.equal(isMapApproved(repo), false, 'fixture: not approved before');
    const { result, err } = await run(repo);
    assert.equal(result, 0, err);
    assert.equal(isMapApproved(repo), true);
    const a = readJson<Record<string, unknown>>(path.join(repo, '.bastion', 'approval.json'));
    assert.equal(a.by, 'village-tier');
    assert.deepEqual(Object.keys(a).sort(), ['at', 'by', 'mapSha256']);
    assert.match(String(a.mapSha256), /^[0-9a-f]{64}$/);
    assert.ok(!Number.isNaN(Date.parse(String(a.at))), 'at is a timestamp');
  });

  it('step 6: commits the stub files only, with the contract message, leaving no stub uncommitted', async () => {
    const repo = okRepo({ 'docs/keep.md': 'x\n' });
    const before = head(repo);
    const { result, err } = await run(repo);
    assert.equal(result, 0, err);
    assert.equal(git(['rev-list', '--count', `${before}..HEAD`], repo), '1', 'exactly one new commit');
    assert.equal(git(['log', '-1', '--format=%s'], repo), 'chore(bastion): village contract stubs');
    const files = git(['show', '--name-only', '--format=', 'HEAD'], repo).split(/\r?\n/).filter(Boolean).sort();
    assert.deepEqual(files, [...STUB_PATHS].sort());
    assert.equal(git(['status', '--porcelain', '--', 'src'], repo), '', 'no stub left uncommitted');
    assert.equal(git(['ls-files', '--', TEST_FILE], repo), '', 'the test file is not created');
    assert.equal(fs.existsSync(path.join(repo, TEST_FILE)), false);
  });

  it('prints "[bastion] contract: <n> stub file(s), tests will go to <testFile>."', async () => {
    const repo = okRepo();
    const { result, out } = await run(repo);
    assert.equal(result, 0);
    assert.ok(out.split(/\r?\n/).includes(`[bastion] contract: 2 stub file(s), tests will go to ${TEST_FILE}.`), out);
  });

  it('removes an old output first: a stale contract.json cannot stand in for a role that wrote none', async () => {
    const repo = contractRepo({ files: STUBS }); // role writes stubs but no output
    writeRepoFile(repo, '.bastion/maps/contract.json', JSON.stringify(goodOutput()));
    const before = head(repo);
    const { result, err } = await run(repo);
    assert.equal(result, 1, 'stale output must not be used');
    assert.match(err, /\[bastion\] contract:/);
    assertFailedCleanly(repo, before);
  });
});

// ---------------------------------------------------------------- runContract: failures

describe('v1.1 runContract step 1 failures', () => {
  it('a blank requirement fails without calling the role', async () => {
    for (const requirement of ['', '   ', '\n\t ']) {
      const repo = okRepo();
      const before = head(repo);
      const { result, err } = await run(repo, requirement);
      assert.equal(result, 1, JSON.stringify(requirement));
      assert.match(err, /\[bastion\] contract:/);
      assert.equal(readRoleCalls(repo).length, 0, 'role not called');
      assertFailedCleanly(repo, before);
    }
  });

  it('outside a git repository it fails with exit 1', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bastion-v11-nogit-'));
    try {
      const { result, err } = await run(dir);
      assert.equal(result, 1);
      assert.match(err, /\[bastion\] contract:/);
      assert.equal(fs.existsSync(path.join(dir, '.bastion', 'requirement.md')), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('without a readable config it fails with exit 1 and does not call a role', async () => {
    const repo = createTempGitRepo();
    writeRepoFile(repo, 'a.txt', 'a\n');
    git(['add', '.'], repo);
    git(['commit', '-m', 'init'], repo);
    const { result, err } = await run(repo);
    assert.equal(result, 1);
    assert.match(err, /\[bastion\] contract:/);
    assert.equal(readRoleCalls(repo).length, 0);
  });
});

describe('v1.1 runContract step 3 failures (each returns 1, names the problem, commits nothing)', () => {
  it('role exits non-zero, even though it wrote a valid output and the stubs', async () => {
    const repo = contractRepo({ files: STUBS, output: goodOutput(), exit: 1 });
    const before = head(repo);
    const { result, err } = await run(repo);
    assert.equal(result, 1);
    assert.match(err, /\[bastion\] contract:/);
    assertFailedCleanly(repo, before);
  });

  it('output that parseContractOutput rejects (testFile listed in files)', async () => {
    const repo = contractRepo({ files: STUBS, output: goodOutput({ testFile: STUB_PATHS[0] }) });
    const before = head(repo);
    const { result, err } = await run(repo);
    assert.equal(result, 1);
    assert.match(err, /\[bastion\] contract:/);
    assertFailedCleanly(repo, before);
  });

  it('role wrote no output at all', async () => {
    const repo = contractRepo({ files: STUBS });
    const before = head(repo);
    const { result } = await run(repo);
    assert.equal(result, 1);
    assertFailedCleanly(repo, before);
  });

  it('a listed stub file is missing', async () => {
    const repo = contractRepo({ files: { 'src/add.mjs': STUBS['src/add.mjs'] }, output: goodOutput() });
    const before = head(repo);
    const { result, err } = await run(repo);
    assert.equal(result, 1);
    assert.match(err, /\[bastion\] contract:/);
    assertFailedCleanly(repo, before);
  });

  it('a listed stub file is empty', async () => {
    const repo = contractRepo({ files: { ...STUBS, 'src/mul.mjs': '' }, output: goodOutput() });
    const before = head(repo);
    const { result, err } = await run(repo);
    assert.equal(result, 1);
    assert.match(err, /\[bastion\] contract:/);
    assertFailedCleanly(repo, before);
  });

  it('the testFile already exists', async () => {
    const repo = contractRepo({ files: STUBS, output: goodOutput() }, { [TEST_FILE]: '// existing test\n' });
    const before = head(repo);
    const { result, err } = await run(repo);
    assert.equal(result, 1);
    assert.match(err, /\[bastion\] contract:/);
    assertFailedCleanly(repo, before);
    assert.equal(fs.readFileSync(path.join(repo, TEST_FILE), 'utf8'), '// existing test\n', 'existing test untouched');
  });

  it('the role created the testFile itself', async () => {
    const repo = contractRepo({ files: { ...STUBS, [TEST_FILE]: '// sneaky\n' }, output: goodOutput() });
    const before = head(repo);
    const { result } = await run(repo);
    assert.equal(result, 1);
    assertFailedCleanly(repo, before);
  });

  it('the role edited a tracked file that is not in the list, and the error names it', async () => {
    const repo = contractRepo({ files: { ...STUBS, 'README.md': '# changed by the role\n' }, output: goodOutput() });
    const before = head(repo);
    const { result, err } = await run(repo);
    assert.equal(result, 1);
    assert.ok(err.includes('README.md'), err);
    assertFailedCleanly(repo, before);
  });

  it('the role left an untracked file outside the list (even nested), and the error names the full path', async () => {
    const repo = contractRepo({ files: { ...STUBS, 'docs/deep/extra.md': 'x\n', 'src/extra.mjs': 'export {};\n' }, output: goodOutput() });
    const before = head(repo);
    const { result, err } = await run(repo);
    assert.equal(result, 1);
    assert.ok(err.includes('docs/deep/extra.md'), `lists untracked files individually: ${err}`);
    assert.ok(err.includes('src/extra.mjs'), err);
    assertFailedCleanly(repo, before);
  });
});

// ---------------------------------------------------------------- identity

const ID_VARS = [
  'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM',
  'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL',
] as const;

/** Remove the repo's local identity and hide every other git config for the duration of fn; restores everything. */
async function withoutGitIdentity<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  git(['config', '--unset', 'user.email'], repo);
  git(['config', '--unset', 'user.name'], repo);
  git(['config', 'user.useConfigOnly', 'true'], repo);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bastion-v11-contract-gitcfg-'));
  const empty = path.join(dir, 'empty.gitconfig');
  fs.writeFileSync(empty, '');
  const saved = new Map<string, string | undefined>(ID_VARS.map((k) => [k, process.env[k]]));
  for (const k of ID_VARS) delete process.env[k];
  process.env.GIT_CONFIG_GLOBAL = empty;
  process.env.GIT_CONFIG_SYSTEM = empty;
  try {
    return await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('v1.1 runContract commit identity', () => {
  it('commits as bastion <bastion@local> when the repo has no user.email, without persisting an identity', async () => {
    const repo = okRepo();
    const { result, err } = await withoutGitIdentity(repo, () => run(repo));
    assert.equal(result, 0, err);
    assert.equal(git(['log', '-1', '--format=%s'], repo), 'chore(bastion): village contract stubs');
    assert.equal(git(['log', '-1', '--format=%ae|%an|%ce'], repo), 'bastion@local|bastion|bastion@local');
    assert.equal(isMapApproved(repo), true);
  });

  it('keeps the configured identity when there is one', async () => {
    const repo = okRepo();
    const { result, err } = await run(repo);
    assert.equal(result, 0, err);
    assert.equal(git(['log', '-1', '--format=%ae|%an|%ce'], repo), 'test@bastion.local|Bastion Test|test@bastion.local');
  });
});
