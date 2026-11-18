#!/usr/bin/env node
// Control-group agent: one plain `claude -p` session, same isolation flags and usage logging as
// scripts/dogfood-agent.mjs, but no bastion preamble, no lock, no gate.
// Usage: node agent.mjs <promptFile> <label> <usageJsonl>   (cwd = the clone to work in)
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';

const [promptFile, label, usageFile] = process.argv.slice(2);
const prompt = fs.readFileSync(promptFile, 'utf8');
const env = { ...process.env };
for (const k of Object.keys(env)) {
  if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_') || k.startsWith('CLAUDE_AGENT_SDK') ||
      k === 'CLAUDE_PID' || k === 'CLAUDE_EFFORT' || k === 'CLAUDE_PREVIEW_CLASSIFIER_FLOOR' ||
      k === 'ANTHROPIC_BASE_URL' || k.startsWith('BASTION_')) {
    delete env[k];
  }
}
const args = [
  '-p', '--model', 'sonnet', '--output-format', 'json',
  '--permission-mode', 'acceptEdits',
  '--setting-sources', 'project,local', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence',
  '--allowedTools', 'Read', 'Edit', 'Write', 'Glob', 'Grep',
  'Bash(npm run:*)', 'Bash(npm test:*)', 'Bash(node:*)', 'Bash(npx tsc:*)',
  'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)',
];
const started = Date.now();
const child = spawn('claude', args, { env, stdio: ['pipe', 'pipe', 'inherit'] });
let out = '';
child.stdout.on('data', (d) => { out += String(d); });
child.stdin.end(prompt);
child.on('close', (code) => {
  let r = null;
  try { r = JSON.parse(out); } catch { /* ignore */ }
  process.stdout.write((r?.result ?? out) + '\n');
  fs.appendFileSync(usageFile, JSON.stringify({
    at: new Date().toISOString(), node: label, attempt: 1, model: 'sonnet', exitCode: code,
    isError: r?.is_error ?? true, durationMs: Date.now() - started, numTurns: r?.num_turns ?? null,
    costUsd: r?.total_cost_usd ?? null, usage: r?.usage ?? null, promptChars: prompt.length,
  }) + '\n');
  process.exit(code ?? 1);
});
