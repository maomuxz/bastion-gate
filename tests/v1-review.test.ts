// P3 - bastion review: plain-language brief, approval bound to the exact map bytes.
import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { isMapApproved, renderBrief, runReview } from '../src/commands/review.js';
import { APPROVAL_REL_PATH, BRIEF_REL_PATH } from '../src/commands/stages.js';
import { captureConsole, cleanupTempRepos, createTempGitRepo, writeRepoFile } from './v04-helpers.js';
import { sampleMap } from './v1-helpers.js';

afterEach(cleanupTempRepos);

const NO_DIFF = '# Map diff\n\nNo differences.\n';
const THREE_DIFFS = [
  '# Map diff',
  '',
  '## Only in planner map',
  '- n3',
  '',
  '## Dependencies',
  '- n2: A depends on [n1] / B depends on []',
  '',
  '## File ownership',
  '- src/add.mjs: A n1 / B n2',
  '',
].join('\n');

function sha(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function writeMap(repo: string): string {
  writeRepoFile(repo, '.bastion/map.json', JSON.stringify(sampleMap(), null, 2) + '\n');
  return path.join(repo, '.bastion', 'map.json');
}

describe('v1.0 P3 renderBrief', () => {
  it('contains requirement, numbered nodes with title, summary and every acceptance sentence', () => {
    const map = sampleMap();
    const md = renderBrief(map, NO_DIFF);
    assert.ok(md.includes(map.requirement), 'requirement');
    for (const n of map.nodes) {
      assert.ok(md.includes(n.title), `title ${n.title}`);
      assert.ok(md.includes(n.summary), `summary of ${n.id}`);
      for (const a of n.acceptance) assert.ok(md.includes(a), `acceptance ${a}`);
    }
    assert.match(md, /^[ \t]*(?:#+[ \t]*)?1[.)]|^#+[ \t]*(?:Node[ \t]*)?1\b/im, 'first node numbered 1');
    assert.match(md, /^[ \t]*(?:#+[ \t]*)?2[.)]|^#+[ \t]*(?:Node[ \t]*)?2\b/im, 'second node numbered 2');
    assert.ok(md.indexOf(map.nodes[0].title) < md.indexOf(map.nodes[1].title));
  });

  it('is plain language: no raw interface signatures or test commands leaked', () => {
    const md = renderBrief(sampleMap(), NO_DIFF);
    assert.ok(!md.includes('export function add'));
    assert.ok(!md.includes('node --test'));
  });

  it('reports 0 disagreements for "No differences."', () => {
    const md = renderBrief(sampleMap(), NO_DIFF);
    assert.match(md, /disagree[^\n]*\b0\b|\b0\b[^\n]*disagree/i);
  });

  it('reports the number of "- " items in the diff (3), not sections or 0', () => {
    const md = renderBrief(sampleMap(), THREE_DIFFS);
    assert.match(md, /disagree[^\n]*\b3\b|\b3\b[^\n]*disagree/i);
    assert.doesNotMatch(md, /disagree[^\n]*\b0\b/i);
  });
});

describe('v1.0 P3 isMapApproved', () => {
  it('is false without approval.json, even with a map', () => {
    const repo = createTempGitRepo();
    writeMap(repo);
    assert.equal(isMapApproved(repo), false);
  });

  it('is true when approval.json mapSha256 equals the sha256 of map.json bytes', () => {
    const repo = createTempGitRepo();
    const mapFile = writeMap(repo);
    writeRepoFile(repo, APPROVAL_REL_PATH, JSON.stringify({ mapSha256: sha(mapFile), at: 'now' }));
    assert.equal(isMapApproved(repo), true);
  });

  it('is false when the hash is wrong, stale after a whitespace edit, or approval is unparseable', () => {
    const repo = createTempGitRepo();
    const mapFile = writeMap(repo);
    writeRepoFile(repo, APPROVAL_REL_PATH, JSON.stringify({ mapSha256: 'deadbeef', at: 'now' }));
    assert.equal(isMapApproved(repo), false);
    writeRepoFile(repo, APPROVAL_REL_PATH, JSON.stringify({ mapSha256: sha(mapFile), at: 'now' }));
    fs.appendFileSync(mapFile, '\n');
    assert.equal(isMapApproved(repo), false);
    writeRepoFile(repo, APPROVAL_REL_PATH, '{not json');
    assert.equal(isMapApproved(repo), false);
  });
});

describe('v1.0 P3 runReview', () => {
  it('writes .bastion/brief.md and prints it, without approving', async () => {
    const repo = createTempGitRepo();
    writeMap(repo);
    writeRepoFile(repo, '.bastion/map-diff.md', NO_DIFF);
    const { result, out } = await captureConsole(() => runReview({ cwd: repo }));
    assert.equal(result, 0);
    const brief = fs.readFileSync(path.join(repo, BRIEF_REL_PATH), 'utf8');
    assert.ok(brief.includes(sampleMap().requirement));
    assert.ok(out.includes(sampleMap().nodes[0].summary), 'brief printed to stdout');
    assert.equal(fs.existsSync(path.join(repo, APPROVAL_REL_PATH)), false);
    assert.equal(isMapApproved(repo), false);
  });

  it('--approve writes approval.json {mapSha256, at} matching the map bytes', async () => {
    const repo = createTempGitRepo();
    const mapFile = writeMap(repo);
    writeRepoFile(repo, '.bastion/map-diff.md', THREE_DIFFS);
    const { result } = await captureConsole(() => runReview({ cwd: repo, approve: true }));
    assert.equal(result, 0);
    const a = JSON.parse(fs.readFileSync(path.join(repo, APPROVAL_REL_PATH), 'utf8'));
    assert.equal(a.mapSha256, sha(mapFile));
    assert.equal(typeof a.at, 'string');
    assert.ok(a.at.length > 0);
    assert.equal(isMapApproved(repo), true);
    assert.ok(fs.existsSync(path.join(repo, BRIEF_REL_PATH)));
  });

  it('changing the map after approval invalidates it; re-approving fixes it', async () => {
    const repo = createTempGitRepo();
    const mapFile = writeMap(repo);
    writeRepoFile(repo, '.bastion/map-diff.md', NO_DIFF);
    await captureConsole(() => runReview({ cwd: repo, approve: true }));
    const edited = sampleMap();
    edited.nodes[0].title = 'Add (edited)';
    fs.writeFileSync(mapFile, JSON.stringify(edited, null, 2) + '\n');
    assert.equal(isMapApproved(repo), false);
    const { result } = await captureConsole(() => runReview({ cwd: repo, approve: true }));
    assert.equal(result, 0);
    assert.equal(isMapApproved(repo), true);
  });

  it('returns 1 with no map and writes neither brief nor approval', async () => {
    const repo = createTempGitRepo();
    const { result } = await captureConsole(() => runReview({ cwd: repo, approve: true }));
    assert.equal(result, 1);
    assert.equal(fs.existsSync(path.join(repo, BRIEF_REL_PATH)), false);
    assert.equal(fs.existsSync(path.join(repo, APPROVAL_REL_PATH)), false);
  });
});
