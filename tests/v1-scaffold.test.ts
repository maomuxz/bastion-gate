// v1.0 P12 - `bastion scaffold`: one worker call, node files must exist, committed as "chore(bastion): scaffold".
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { runScaffold } from '../src/commands/scaffold.js';
import { captureConsole, cleanupTempRepos, git } from './v04-helpers.js';
import { createRoleRepo, readRoleCalls, sampleMap, SAMPLE_FILES } from './v1-helpers.js';

afterEach(cleanupTempRepos);

const INTERFACES_TEXT = 'ES modules under src/, one function per file. UNIQUE-IFACE-MARKER';

function makeRepo(workerFiles: Record<string, string> | undefined, workerExit = 0, withMap = true): string {
  return createRoleRepo({
    fixtures: { worker: { files: workerFiles, exit: workerExit } },
    files: {
      ...(withMap ? { '.bastion/map.json': JSON.stringify(sampleMap(), null, 2) } : {}),
      '.bastion/interfaces.md': INTERFACES_TEXT + '\n',
    },
  });
}

describe('v1.0 scaffold', () => {
  it('calls the worker once, creates every node file and commits them as "chore(bastion): scaffold"', async () => {
    const repo = makeRepo({ ...SAMPLE_FILES.stubs });
    const before = git(['rev-parse', 'HEAD'], repo).trim();
    const { result } = await captureConsole(() => runScaffold({ cwd: repo }));
    assert.equal(result, 0);

    for (const rel of Object.keys(SAMPLE_FILES.stubs)) {
      assert.ok(fs.existsSync(path.join(repo, rel)), `${rel} should exist`);
    }
    const calls = readRoleCalls(repo);
    assert.equal(calls.length, 1, 'exactly one role call');
    assert.equal(calls[0].role, 'worker');

    assert.equal(git(['log', '-1', '--format=%s'], repo).trim(), 'chore(bastion): scaffold');
    assert.equal(git(['rev-parse', 'HEAD~1'], repo).trim(), before, 'exactly one new commit');
    const committed = git(['show', '--name-only', '--format=', 'HEAD'], repo).split(/\r?\n/).map((s) => s.trim());
    assert.ok(committed.includes('src/add.mjs'));
    assert.ok(committed.includes('src/mul.mjs'));
  });

  it('tells the worker the interfaces.md text and every node\'s files and interface', async () => {
    const repo = makeRepo({ ...SAMPLE_FILES.stubs });
    await captureConsole(() => runScaffold({ cwd: repo }));
    const prompt = readRoleCalls(repo)[0]?.prompt ?? '';
    assert.ok(prompt.includes('UNIQUE-IFACE-MARKER'), 'interfaces.md content in prompt');
    for (const n of sampleMap().nodes) {
      for (const f of n.files) assert.ok(prompt.includes(f), `prompt mentions ${f}`);
      assert.ok(prompt.includes(n.interface), `prompt includes interface of ${n.id}`);
    }
  });

  it('returns 1 and commits nothing when a node file is missing after the worker ran', async () => {
    const repo = makeRepo({ 'src/add.mjs': SAMPLE_FILES.stubs['src/add.mjs'] });
    const before = git(['rev-parse', 'HEAD'], repo).trim();
    const { result } = await captureConsole(() => runScaffold({ cwd: repo }));
    assert.equal(result, 1);
    assert.equal(git(['rev-parse', 'HEAD'], repo).trim(), before, 'no scaffold commit on failure');
    assert.equal(readRoleCalls(repo).length, 1, 'the worker was still called once');
  });

  it('returns 1 without calling any role when map.json is missing', async () => {
    const repo = makeRepo({ ...SAMPLE_FILES.stubs }, 0, false);
    const before = git(['rev-parse', 'HEAD'], repo).trim();
    const { result } = await captureConsole(() => runScaffold({ cwd: repo }));
    assert.equal(result, 1);
    assert.equal(readRoleCalls(repo).length, 0);
    assert.equal(git(['rev-parse', 'HEAD'], repo).trim(), before);
    assert.ok(!fs.existsSync(path.join(repo, 'src/add.mjs')));
  });
});
