// P11 - README "original design vs implemented" matrix, in both languages, with nothing left as planned.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { describe, it } from 'node:test';

const FEATURES = ['map', 'review', 'scaffold', 'tests', 'run', 'gate', 'lock', 'mutate', 'audit', 'qa', 'flow', 'summary', 'decisions', 'answer', 'budget', 'checks', 'roles'];

function matrixRows(file: string): string[] {
  const text = fs.readFileSync(file, 'utf8');
  const start = text.indexOf('<!-- feature-matrix:start -->');
  const end = text.indexOf('<!-- feature-matrix:end -->');
  assert.ok(start >= 0 && end > start, `${file} has <!-- feature-matrix:start --> ... <!-- feature-matrix:end -->`);
  return text.slice(start, end).split(/\r?\n/).filter((l) => l.trim().startsWith('|'));
}

describe('v1.0 P11 README feature matrix', () => {
  for (const file of ['README.md', 'README.zh-CN.md']) {
    it(`${file} lists every feature as implemented`, () => {
      const rows = matrixRows(file);
      for (const f of FEATURES) {
        const row = rows.find((r) => r.includes(`\`${f}\``));
        assert.ok(row, `${file}: matrix row for \`${f}\``);
        assert.ok(row!.includes('✅'), `${file}: \`${f}\` marked ✅`);
      }
      assert.ok(!rows.some((r) => /planned|计划中|⏳|❌/.test(r)), `${file}: nothing left as planned`);
    });
  }
});
