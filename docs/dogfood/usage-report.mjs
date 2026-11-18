#!/usr/bin/env node
// Summarise .bastion/logs/usage.jsonl written by scripts/dogfood-agent.mjs.
// Usage: node docs/dogfood/usage-report.mjs [repoRoot] [--md out.md]
import * as fs from 'node:fs';
import * as path from 'node:path';

const args = process.argv.slice(2);
const mdIdx = args.indexOf('--md');
const mdOut = mdIdx >= 0 ? args[mdIdx + 1] : null;
const root = args.find((a, i) => !a.startsWith('--') && i !== mdIdx + 1) ?? process.cwd();
const file = path.join(root, '.bastion', 'logs', 'usage.jsonl');
if (!fs.existsSync(file)) {
  console.error(`no ${file}`);
  process.exit(1);
}
const recs = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));

const zero = () => ({ calls: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, cost: 0, ms: 0, turns: 0, errors: 0 });
function add(acc, r) {
  const u = r.usage ?? {};
  acc.calls += 1;
  acc.input += u.input_tokens ?? 0;
  acc.cacheWrite += u.cache_creation_input_tokens ?? 0;
  acc.cacheRead += u.cache_read_input_tokens ?? 0;
  acc.output += u.output_tokens ?? 0;
  acc.cost += r.costUsd ?? 0;
  acc.ms += r.durationMs ?? 0;
  acc.turns += r.numTurns ?? 0;
  acc.errors += r.isError ? 1 : 0;
  return acc;
}
const total = (a) => a.input + a.cacheWrite + a.cacheRead + a.output;

const byNode = new Map();
const firstTry = zero();
const rework = zero();
const all = zero();
for (const r of recs) {
  if (!byNode.has(r.node)) byNode.set(r.node, zero());
  add(byNode.get(r.node), r);
  add(r.attempt > 1 ? rework : firstTry, r);
  add(all, r);
}

const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
const row = (name, a) =>
  `| ${name} | ${a.calls} | ${k(a.input)} | ${k(a.cacheWrite)} | ${k(a.cacheRead)} | ${k(a.output)} | ${k(total(a))} | ${total(all) ? `${((total(a) / total(all)) * 100).toFixed(0)}%` : '-'} | $${a.cost.toFixed(2)} | ${(a.ms / 60000).toFixed(1)} | ${a.turns} |`;

const lines = [
  `# 自举用量统计（${recs.length} 次调用，模型 ${[...new Set(recs.map((r) => r.model))].join('/')}）`,
  '',
  '| 块 | 调用 | 新输入 | 缓存写 | 缓存读 | 输出 | 合计 | 占比 | 折算美元* | 分钟 | 轮数 |',
  '|---|---|---|---|---|---|---|---|---|---|---|',
  ...[...byNode.entries()].sort().map(([n, a]) => row(n, a)),
  row('**一次做对的那次**', firstTry),
  row('**返工（第 2 次及以后）**', rework),
  row('**合计**', all),
  '',
  '* 折算美元是 CLI 按 API 价算的参考值；订阅额度下不直接扣钱，但能看出相对大小。',
];
const text = lines.join('\n');
console.log(text);
if (mdOut) fs.writeFileSync(mdOut, text + '\n', 'utf8');
