#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bastionCli = path.resolve(__dirname, '../dist/cli.js');
const targetDir = path.resolve(process.argv[2] || './ledger-bench');

if (!fs.existsSync(bastionCli)) {
  console.error('Missing dist/cli.js. Run "npm run build" in bastion-gate first.');
  process.exit(1);
}
if (fs.existsSync(targetDir) && fs.readdirSync(targetDir).length > 0) {
  console.error(`Target directory is not empty: ${targetDir}`);
  process.exit(1);
}

function write(rel, content) {
  const full = path.join(targetDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}

function run(cmd, args) {
  execFileSync(cmd, args, { cwd: targetDir, stdio: 'inherit' });
}

fs.mkdirSync(targetDir, { recursive: true });
run('git', ['init', '-b', 'main']);
run('git', ['config', 'user.name', 'Bastion Bench']);
run('git', ['config', 'user.email', 'bench@bastion.local']);

run('node', [bastionCli, 'init', '--test-cmd', 'node --test tests/*.test.mjs', '--base', 'main']);

// Stubs with fixed exported signatures
write('src/csv.mjs', 'export function parseCsv(text) { return []; }\n');
write('src/category.mjs', "export function categorize(merchant) { return 'other'; }\n");
write('src/money.mjs', "export function toCents(s) { return 0; }\nexport function formatCents(c) { return ''; }\n");
write('src/stats.mjs', 'export function summarize(rows) { return { totalCents: 0, top3: [] }; }\n');
write('src/cli.mjs', "export function buildReport(csvText) { return ''; }\n");

// 5 red acceptance tests with edge cases
write(
  'tests/csv.test.mjs',
  `import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../src/csv.mjs';

test('parses quoted comma fields and strips UTF-8 BOM', () => {
  const rows = parseCsv('\\uFEFFdate,merchant,amount\\n2026-01-01,"Cafe, Inc.",12.50\\n');
  assert.deepEqual(rows, [{ date: '2026-01-01', merchant: 'Cafe, Inc.', amount: '12.50' }]);
});
`
);

write(
  'tests/category.test.mjs',
  `import test from 'node:test';
import assert from 'node:assert/strict';
import { categorize } from '../src/category.mjs';

test('categorizes dining, transport, and fallback merchants', () => {
  assert.equal(categorize('Meituan Lunch'), 'food');
  assert.equal(categorize('DiDi Ride'), 'transport');
  assert.equal(categorize('Unknown Shop'), 'other');
});
`
);

write(
  'tests/money.test.mjs',
  `import test from 'node:test';
import assert from 'node:assert/strict';
import { toCents, formatCents } from '../src/money.mjs';

test('parses currency symbols, commas, negatives into integer cents', () => {
  assert.equal(toCents('-¥1,234.56'), -123456);
  assert.equal(toCents('0.10') + toCents('0.20'), 30);
  assert.equal(formatCents(123456), '1234.56');
});
`
);

write(
  'tests/stats.test.mjs',
  `import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from '../src/stats.mjs';

test('computes totalCents and top3 categories sorted descending', () => {
  const res = summarize([
    { category: 'food', cents: 500 },
    { category: 'rent', cents: 3000 },
    { category: 'book', cents: 200 },
    { category: 'cafe', cents: 100 },
    { category: 'food', cents: 400 },
  ]);
  assert.equal(res.totalCents, 4200);
  assert.deepEqual(res.top3.map((x) => x.category), ['rent', 'food', 'book']);
});
`
);

write(
  'tests/cli.test.mjs',
  `import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReport } from '../src/cli.mjs';

test('builds full ledger report from CSV text', () => {
  const out = buildReport('date,merchant,amount\\n2026-01-01,Meituan Lunch,25.00\\n2026-01-02,DiDi Ride,15.50\\n');
  assert.match(out, /Total: 40\\.50/);
  assert.match(out, /food: 25\\.00/);
  assert.match(out, /transport: 15\\.50/);
});
`
);

write(
  '.bastion/acceptance.md',
  `- Parses quoted CSV fields and strips UTF-8 BOM
- Categorizes dining, transport, and fallback merchants
- Parses currency symbols, commas, and negatives into integer cents
- Computes totalCents and top 3 categories descending
- Builds end-to-end ledger report from CSV
`
);

write(
  '.bastion/plan.json',
  JSON.stringify(
    {
      version: 1,
      nodes: [
        {
          id: 'csv',
          title: 'CSV parser',
          prompt: 'Implement parseCsv(text) in src/csv.mjs so tests/csv.test.mjs passes. Do not modify tests/ or .bastion/.',
          testCommand: 'node --test tests/csv.test.mjs',
          tier: 1,
        },
        {
          id: 'category',
          title: 'Merchant categorizer',
          prompt: 'Implement categorize(merchant) in src/category.mjs so tests/category.test.mjs passes. Do not modify tests/ or .bastion/.',
          testCommand: 'node --test tests/category.test.mjs',
          tier: 1,
        },
        {
          id: 'money',
          title: 'Money cents helper',
          prompt: 'Implement toCents(s) and formatCents(c) in src/money.mjs so tests/money.test.mjs passes. Do not modify tests/ or .bastion/.',
          testCommand: 'node --test tests/money.test.mjs',
          tier: 1,
        },
        {
          id: 'stats',
          title: 'Stats summarizer',
          prompt: 'Implement summarize(rows) in src/stats.mjs so tests/stats.test.mjs passes. Do not modify tests/ or .bastion/.',
          testCommand: 'node --test tests/stats.test.mjs',
          tier: 1,
        },
        {
          id: 'cli',
          title: 'CLI report builder',
          dependsOn: ['csv', 'category', 'money', 'stats'],
          prompt: 'Implement buildReport(csvText) in src/cli.mjs using src/csv.mjs, src/category.mjs, src/money.mjs, and src/stats.mjs so tests/cli.test.mjs passes. Do not modify tests/ or .bastion/.',
          testCommand: 'node --test tests/cli.test.mjs',
          tier: 1,
        },
      ],
    },
    null,
    2
  ) + '\n'
);

run('git', ['add', '.']);
run('git', ['commit', '-m', 'chore: initialize ledger benchmark baseline']);
run('node', [bastionCli, 'lock']);
run('git', ['add', '.bastion/lock.json']);
run('git', ['commit', '-m', 'chore: lock red acceptance tests']);

const cliRel = path.relative(targetDir, bastionCli).replace(/\\/g, '/');
console.log(`\n[ready] Benchmark repo created at: ${targetDir}`);
console.log('Run with a real AI agent (example):');
console.log(`  cd "${targetDir}"`);
console.log(`  node "${cliRel}" run --agent "claude -p --permission-mode acceptEdits --allowedTools \\"Bash(node --test:*)\\" < {promptFile}" --concurrency 4 --verify-runs 2`);
console.log(`  node "${cliRel}" audit`);
console.log(`  node "${cliRel}" mutate src/`);
