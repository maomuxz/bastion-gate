#!/usr/bin/env node
// Agent wrapper used to build bastion with bastion (v0.4 dogfood).
// - feeds the node prompt (BASTION_PROMPT_FILE) to `claude -p` on stdin
// - isolates the call: no user-level settings/CLAUDE.md, no MCP servers, no skills
// - strips env inherited from a parent Claude Code session so the CLI uses its own login
// - appends one usage record per call to <repo>/.bastion/logs/usage.jsonl (budget statistics)
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const promptFile = process.env.BASTION_PROMPT_FILE;
const home = process.env.BASTION_HOME;
const nodeId = process.env.BASTION_NODE_ID ?? '?';
const attempt = Number(process.env.BASTION_ATTEMPT ?? '0');
const model = process.env.BASTION_DOGFOOD_MODEL ?? 'sonnet';
if (!promptFile || !fs.existsSync(promptFile)) {
  console.error('dogfood-agent: BASTION_PROMPT_FILE missing');
  process.exit(1);
}

const PREAMBLE = `You are a construction worker inside "bastion run" (node ${nodeId}, attempt ${attempt}).
Your current directory is an isolated git worktree. Rules:
- Make the locked acceptance tests for your node pass by editing ONLY the source file(s) named in the task.
- Never edit anything under tests/, package.json, package-lock.json, tsconfig*.json or .bastion/ (the gate rejects it).
- Run your node's test command yourself before finishing and iterate until it passes.
- Do not commit; bastion commits verified work for you.
- If you make a reversible design choice the task does not dictate, record it:
  node "$BASTION_CLI" decide --title "<what>" --chosen "<choice>" --why "<reason>" --undo "<how to revert>"
- If you hit a decision that is irreversible or outside your task, ask instead of guessing, then stop:
  node "$BASTION_CLI" ask --question "<question>" --recommend "<your recommendation>"
- If a locked test itself is wrong, write the reason to .bastion/disputes/${nodeId}.md and stop.
Keep the final reply to one short paragraph.

`;
const prompt = PREAMBLE + fs.readFileSync(promptFile, 'utf8');

const env = { ...process.env };
for (const k of Object.keys(env)) {
  if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_') || k.startsWith('CLAUDE_AGENT_SDK') ||
      k === 'CLAUDE_PID' || k === 'CLAUDE_EFFORT' || k === 'CLAUDE_PREVIEW_CLASSIFIER_FLOOR' ||
      k === 'ANTHROPIC_BASE_URL') {
    delete env[k];
  }
}

const args = [
  '-p',
  '--model', model,
  '--output-format', 'json',
  '--permission-mode', 'acceptEdits',
  '--setting-sources', 'project,local',
  '--strict-mcp-config',
  '--disable-slash-commands',
  '--no-session-persistence',
  '--allowedTools',
  'Read', 'Edit', 'Write', 'Glob', 'Grep',
  'Bash(npm run:*)', 'Bash(npm test:*)', 'Bash(node:*)', 'Bash(npx tsc:*)',
  'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)',
];

const started = Date.now();
const child = spawn('claude', args, { env, stdio: ['pipe', 'pipe', 'inherit'] });
let out = '';
child.stdout.on('data', (d) => { out += String(d); });
child.stdin.end(prompt);
child.on('close', (code) => {
  let result = null;
  try { result = JSON.parse(out); } catch { /* non-JSON output */ }
  process.stdout.write((result?.result ?? out) + '\n');

  if (home) {
    const rec = {
      at: new Date().toISOString(),
      node: nodeId,
      attempt,
      model,
      exitCode: code,
      isError: result?.is_error ?? true,
      durationMs: Date.now() - started,
      numTurns: result?.num_turns ?? null,
      costUsd: result?.total_cost_usd ?? null,
      usage: result?.usage ?? null,
      modelUsage: result?.modelUsage ?? null,
      promptChars: prompt.length,
    };
    const file = path.join(home, '.bastion', 'logs', 'usage.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8');
  }
  process.exit(code === 0 && result && !result.is_error ? 0 : 1);
});
