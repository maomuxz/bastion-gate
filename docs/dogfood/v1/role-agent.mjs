#!/usr/bin/env node
// Generic role wrapper for real-model runs of `bastion flow`: feeds BASTION_PROMPT_FILE to `claude -p`,
// keeps BASTION_* env (BASTION_OUTPUT, BASTION_CLI ...), strips a parent Claude Code session's env,
// and logs usage per call to <BASTION_HOME>/.bastion/logs/usage.jsonl labelled "<role>:<label>".
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const promptFile = process.env.BASTION_PROMPT_FILE;
const home = process.env.BASTION_HOME ?? process.cwd();
const role = process.env.BASTION_ROLE || 'worker';
const label = `${role}:${process.env.BASTION_NODE_ID ?? '?'}`;
const model = process.env.BASTION_SMOKE_MODEL ?? 'sonnet';
let prompt = fs.readFileSync(promptFile, 'utf8');
if (process.env.BASTION_OUTPUT) prompt += `\n\nWrite your result to this exact file path: ${process.env.BASTION_OUTPUT}\n`;

const env = { ...process.env };
for (const k of Object.keys(env)) {
  if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_') || k.startsWith('CLAUDE_AGENT_SDK') ||
      k === 'CLAUDE_PID' || k === 'CLAUDE_EFFORT' || k === 'CLAUDE_PREVIEW_CLASSIFIER_FLOOR' || k === 'ANTHROPIC_BASE_URL') {
    delete env[k];
  }
}
const args = ['-p', '--model', model, '--output-format', 'json', '--permission-mode', 'acceptEdits',
  '--setting-sources', 'project,local', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence',
  '--allowedTools', 'Read', 'Edit', 'Write', 'Glob', 'Grep',
  'Bash(npm run:*)', 'Bash(npm test:*)', 'Bash(node:*)', 'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)'];
const started = Date.now();
const child = spawn('claude', args, { env, stdio: ['pipe', 'pipe', 'inherit'] });
let out = '';
child.stdout.on('data', (d) => { out += String(d); });
child.stdin.end(prompt);
child.on('close', (code) => {
  let r = null;
  try { r = JSON.parse(out); } catch { /* ignore */ }
  process.stdout.write((r?.result ?? out) + '\n');
  const file = path.join(home, '.bastion', 'logs', 'usage.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({
    at: new Date().toISOString(), node: label, attempt: Number(process.env.BASTION_ATTEMPT ?? 1), model, exitCode: code,
    isError: r?.is_error ?? true, durationMs: Date.now() - started, numTurns: r?.num_turns ?? null,
    costUsd: r?.total_cost_usd ?? null, usage: r?.usage ?? null,
  }) + '\n');
  process.exit(code === 0 && r && !r.is_error ? 0 : 1);
});
