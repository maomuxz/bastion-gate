// N3 - decision ledger: agents record tier-2 decisions via the outbox; the user reads them back.
import * as assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { runSwarm } from '../src/commands/run.js';
import { appendDecisions, DecisionRecord, formatDecisions, readDecisions } from '../src/ledger.js';
import { AGENT_PRELUDE, captureConsole, cleanupTempRepos, createSwarmRepo, createTempGitRepo, git } from './v04-helpers.js';

afterEach(cleanupTempRepos);

describe('v0.4 N3 ledger', () => {
  it('appendDecisions writes tier-2 records with id, timestamp and node, and returns them', () => {
    const repo = createTempGitRepo();
    const added = appendDecisions(repo, 'n1', [
      { title: 'Storage', chosen: 'JSON file', why: 'zero deps', undo: 'switch to sqlite in store.ts' },
    ]);
    assert.equal(added.length, 1);
    const rec = added[0];
    assert.equal(rec.tier, 2);
    assert.equal(rec.node, 'n1');
    assert.equal(rec.title, 'Storage');
    assert.equal(rec.chosen, 'JSON file');
    assert.equal(rec.why, 'zero deps');
    assert.equal(rec.undo, 'switch to sqlite in store.ts');
    assert.ok(rec.id && rec.id.trim(), 'has an id');
    assert.ok(!Number.isNaN(Date.parse(rec.at)), 'at is an ISO timestamp');
    assert.deepEqual(readDecisions(repo), added);
  });

  it('appends keep earlier records, keep order, and never reuse ids', () => {
    const repo = createTempGitRepo();
    appendDecisions(repo, 'n1', [{ title: 'A', chosen: 'a', why: 'x' }]);
    appendDecisions(repo, 'n2', [
      { title: 'B', chosen: 'b', why: 'y' },
      { title: 'C', chosen: 'c', why: 'z' },
    ]);
    const all = readDecisions(repo);
    assert.deepEqual(all.map((d) => d.title), ['A', 'B', 'C']);
    assert.equal(new Set(all.map((d) => d.id)).size, 3);
  });

  it('appending nothing does not create records', () => {
    const repo = createTempGitRepo();
    assert.deepEqual(appendDecisions(repo, 'n1', []), []);
    assert.deepEqual(readDecisions(repo), []);
  });

  it('formatDecisions lists oldest first with what / why / how to undo', () => {
    const records: DecisionRecord[] = [
      { id: 'd2', at: '2026-11-18T10:00:00.000Z', tier: 2, node: 'n2', title: 'Later', chosen: 'L', why: 'because-L' },
      { id: 'd1', at: '2026-11-18T09:00:00.000Z', tier: 2, node: 'n1', title: 'Earlier', chosen: 'E', why: 'because-E', undo: 'revert-E' },
    ];
    const text = formatDecisions(records).join('\n');
    assert.ok(text.indexOf('Earlier') >= 0 && text.indexOf('Later') > text.indexOf('Earlier'), 'sorted by time');
    for (const s of ['E', 'because-E', 'revert-E', 'because-L', 'n1']) assert.ok(text.includes(s), `contains ${s}`);
  });

  it('a decision made inside a node with `bastion decide` lands in the main repo ledger, not in git', async () => {
    const agent = [
      AGENT_PRELUDE,
      `cli('decide', '--title', 'Cache layer', '--chosen', 'in-memory map', '--why', 'simplest', '--undo', 'delete cache.mjs');`,
      `implementNode();`,
    ].join('\n') + '\n';
    const repo = createSwarmRepo({ nodes: [{ id: 'la' }], agentScript: agent });
    const { result } = await captureConsole(() =>
      runSwarm({ cwd: repo, baseRef: 'main', agentCommand: 'node scripts/agent.mjs', maxRetries: 0 })
    );
    assert.equal(result, 0);
    const ledger = readDecisions(repo);
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].node, 'la');
    assert.equal(ledger[0].title, 'Cache layer');
    assert.equal(ledger[0].undo, 'delete cache.mjs');
    const tracked = git(['ls-files'], repo);
    assert.ok(!tracked.includes('.bastion/outbox/'), 'outbox never committed');
    assert.ok(!tracked.includes('.bastion/decisions.json'), 'ledger never committed');
  });
});
