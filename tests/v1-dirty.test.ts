// v1.0 F10 - only files that matter block `bastion run`; stray untracked files do not.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { runSwarm } from '../src/commands/run.js';
import { blockingDirtyFiles } from '../src/dirty.js';
import { captureConsole, cleanupTempRepos, createSwarmRepo, createTempGitRepo, git, writeRepoFile } from './v04-helpers.js';

afterEach(cleanupTempRepos);

const PATTERNS = ['tests/**', '**/*.test.*', 'package.json'];

/** A committed repo with a tracked source file, a tracked test, a tracked .gitignore and a tracked .bastion/config.json. */
function baseRepo(): string {
  const repo = createTempGitRepo();
  writeRepoFile(repo, 'src/app.ts', 'export const a = 1;\n');
  writeRepoFile(repo, 'tests/app.test.ts', 'export {};\n');
  writeRepoFile(repo, '.gitignore', 'ignored.log\nbuild/\n');
  writeRepoFile(repo, '.bastion/config.json', '{}\n');
  git(['add', '.'], repo);
  git(['commit', '-m', 'base'], repo);
  return repo;
}

describe('v1.0 F10 blockingDirtyFiles', () => {
  it('is empty for a clean tree', () => {
    assert.deepEqual(blockingDirtyFiles(baseRepo(), PATTERNS), []);
  });

  it('ignores untracked scratch files, at the root and nested', () => {
    const repo = baseRepo();
    writeRepoFile(repo, 'notes.txt', 'todo\n');
    writeRepoFile(repo, 'logs/run.log', 'x\n');
    writeRepoFile(repo, '.bastion/logs/role-calls.jsonl', '{}\n');
    assert.deepEqual(blockingDirtyFiles(repo, PATTERNS), []);
  });

  it('blocks on an untracked file that matches a locked pattern', () => {
    const repo = baseRepo();
    writeRepoFile(repo, 'tests/new.spec.ts', 'x\n');
    writeRepoFile(repo, 'src/deep/thing.test.ts', 'x\n');
    writeRepoFile(repo, 'package.json', '{}\n');
    writeRepoFile(repo, 'notes.txt', 'ignored\n');
    assert.deepEqual(blockingDirtyFiles(repo, PATTERNS), ['package.json', 'src/deep/thing.test.ts', 'tests/new.spec.ts']);
  });

  it('blocks on an untracked file under tests/ even in a nested directory', () => {
    const repo = baseRepo();
    writeRepoFile(repo, 'tests/sub/dir/helper.ts', 'x\n');
    assert.deepEqual(blockingDirtyFiles(repo, PATTERNS), ['tests/sub/dir/helper.ts']);
  });

  it('blocks on a modified tracked file even if no pattern matches it', () => {
    const repo = baseRepo();
    writeRepoFile(repo, 'src/app.ts', 'export const a = 2;\n');
    assert.deepEqual(blockingDirtyFiles(repo, []), ['src/app.ts']);
  });

  it('blocks on staged, deleted and renamed tracked files', () => {
    const repo = baseRepo();
    writeRepoFile(repo, 'src/extra.ts', 'export {};\n');
    git(['add', 'src/extra.ts'], repo); // staged new file is tracked, so it blocks without matching a pattern
    fs.rmSync(path.join(repo, 'tests/app.test.ts'));
    const out = blockingDirtyFiles(repo, []);
    assert.deepEqual(out, ['src/extra.ts', 'tests/app.test.ts']);

    const repo2 = baseRepo();
    git(['mv', 'src/app.ts', 'src/renamed.ts'], repo2);
    const out2 = blockingDirtyFiles(repo2, []);
    assert.ok(out2.includes('src/renamed.ts'), `rename target should block, got ${JSON.stringify(out2)}`);
    assert.ok(!out2.some((f) => f.includes(' -> ')), 'no raw "old -> new" entries');
  });

  it('blocks on untracked baseline bastion files, but not on other .bastion files', () => {
    const repo = createTempGitRepo();
    writeRepoFile(repo, 'README.md', 'hi\n');
    git(['add', '.'], repo);
    git(['commit', '-m', 'base'], repo);
    for (const f of ['config.json', 'lock.json', 'plan.json', 'map.json', 'interfaces.md', 'acceptance.md']) {
      writeRepoFile(repo, `.bastion/${f}`, 'x\n');
    }
    writeRepoFile(repo, '.bastion/run-state.json', '{}\n');
    writeRepoFile(repo, '.bastion/notes.md', 'x\n');
    assert.deepEqual(blockingDirtyFiles(repo, []), [
      '.bastion/acceptance.md',
      '.bastion/config.json',
      '.bastion/interfaces.md',
      '.bastion/lock.json',
      '.bastion/map.json',
      '.bastion/plan.json',
    ]);
  });

  it('never blocks on gitignored files, even when they match a locked pattern', () => {
    const repo = baseRepo();
    writeRepoFile(repo, 'ignored.log', 'x\n');
    writeRepoFile(repo, 'build/out.js', 'x\n');
    assert.deepEqual(blockingDirtyFiles(repo, ['**/*.log', 'build/**']), []);
  });

  it('returns repo-relative POSIX paths in git status order', () => {
    const repo = baseRepo();
    writeRepoFile(repo, 'src/zeta.ts', 'x\n');
    git(['add', 'src/zeta.ts'], repo);
    writeRepoFile(repo, 'src/app.ts', 'export const a = 3;\n');
    writeRepoFile(repo, 'tests/a/b.ts', 'x\n');
    assert.deepEqual(blockingDirtyFiles(repo, PATTERNS), ['src/app.ts', 'src/zeta.ts', 'tests/a/b.ts']);
  });
});

describe('v1.0 F10 runSwarm dirty check', () => {
  const run = (repo: string) =>
    captureConsole(() => runSwarm({ cwd: repo, baseRef: 'main', agentCommand: 'node scripts/agent.mjs', maxRetries: 0 }));

  it('runs (exit 0) when the only dirt is an untracked scratch file', async () => {
    const repo = createSwarmRepo({ nodes: [{ id: 'a' }] });
    writeRepoFile(repo, 'notes.txt', 'scratch\n');
    const { result, err } = await run(repo);
    assert.equal(result, 0, err);
    assert.doesNotMatch(err, /not clean/);
  });

  it('refuses (exit 1) when a tracked file is modified, naming the file', async () => {
    const repo = createSwarmRepo({ nodes: [{ id: 'a' }] });
    writeRepoFile(repo, 'scripts/agent.mjs', fs.readFileSync(path.join(repo, 'scripts/agent.mjs'), 'utf8') + '// edit\n');
    const { result, err } = await run(repo);
    assert.equal(result, 1);
    assert.match(err, /not clean/);
    assert.match(err, /scripts\/agent\.mjs/);
  });

  it('refuses (exit 1) when an untracked file sits under a locked glob', async () => {
    const repo = createSwarmRepo({ nodes: [{ id: 'a' }] });
    writeRepoFile(repo, 'tests/extra.test.mjs', 'export {};\n');
    const { result, err } = await run(repo);
    assert.equal(result, 1);
    assert.match(err, /tests\/extra\.test\.mjs/);
  });
});
