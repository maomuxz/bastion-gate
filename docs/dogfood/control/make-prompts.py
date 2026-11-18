# Build the B1 / B2 control prompts from the round-1 plan (commit 6d1679b).
import json, subprocess, sys
out_dir = sys.argv[1]
plan = json.loads(subprocess.check_output(['git', 'show', '6d1679b:.bastion/plan.json'], text=True, encoding='utf8'))

def body(n):
    p = n['prompt'].split('\n\n', 1)[1]          # drop the shared header
    return p.split('\n\nYour node test command:')[0]

tasks = '\n\n'.join(f"## {i+1}. {n['title']}\n{body(n)}" for i, n in enumerate(plan['nodes']))

B1 = f"""You are working on bastion-gate (TypeScript, Node 18+, zero runtime dependencies, ESM with .js import suffixes).
The interfaces for six new features already exist as stubs (TODO bodies) and acceptance tests exist under tests/v04-*.test.ts.
Implement all six tasks below. Keep every exported signature as it is. Do not edit tests, package.json or tsconfig files.
Run `npm test` yourself and keep going until the whole suite passes. Do not commit.

{tasks}
"""

SCAFFOLD = """Add these v0.4 features to bastion-gate (TypeScript, Node 18+, zero runtime dependencies, ESM with .js import suffixes).
There are no stubs and no tests for them yet: create the files, wire them in, and make sure `npm test` still passes.
Do not edit package.json or tsconfig files. Do not commit. Follow this contract exactly (names, signatures, strings, exit codes):

### Config (src/config.ts)
- BastionConfig gets optional `roles?: Partial<Record<RoleName,string>>` (RoleName = 'planner'|'tester'|'worker'|'qa'),
  `checks?: string[]`, `budget?: { maxAgentCalls?: number; maxMinutes?: number }`, all parsed from .bastion/config.json.
- LockAmendment / others unchanged. Export `RoleName`, `BastionRoles`, `BastionBudget`.

### New modules
- src/state.ts: `RunState { integrationBranch; baseRef; completedNodes: string[]; agentCalls?; accumulatedMinutes?; blockedNodes?: string[]; budgetHit?: 'calls'|'minutes' }`,
  `readRunState(repoRoot)`, `writeRunState(repoRoot, state)` for .bastion/run-state.json (move the private one out of run.ts).
- src/outbox.ts: agents inside a node worktree never write the main repo. `bastion decide` / `bastion ask` append JSON arrays to
  `<cwd>/.bastion/outbox/<nodeId>.decisions.json` ({title, chosen, why, undo?}) and `<cwd>/.bastion/outbox/<nodeId>.tier3.json`
  ({question, recommend?}); node id from --node or env BASTION_NODE_ID. `collectOutbox(worktreeDir, nodeId)` reads and deletes both.
- src/roles.ts: `resolveAgentCommand(config, role, explicit?)`.
- src/checks.ts: `PreCheckResult {ok; failedCommand?; feedback}`, `runPreChecks(checks, cwd)`, `runPreChecksAsync(checks, cwd)`.
- src/ledger.ts: `DecisionRecord {id; at; tier: 2; node?; title; chosen; why; undo?}`, `DECISIONS_REL_PATH='.bastion/decisions.json'`,
  `readDecisions(repoRoot)`, `appendDecisions(repoRoot, nodeId, drafts)`, `formatDecisions(records): string[]`.
- src/inbox.ts: `InboxItem {id; at; node; question; recommend?; status: 'open'|'answered'; answer?; answeredAt?}`, `INBOX_REL_PATH='.bastion/inbox.json'`,
  `readInbox`, `hasOpenQuestion(repoRoot, nodeId)`, `openQuestions(repoRoot, nodeId, drafts)`, `answerQuestion(repoRoot, id, answer)`, `answersForNode(repoRoot, nodeId)`.
- src/budget.ts: `BudgetLimits {maxAgentCalls?; maxMinutes?}`, `BudgetUsage {agentCalls; minutes}`, `resolveBudgetLimits(config, overrides)`, `checkBudget(usage, limits)`.
- src/summary.ts: `summaryLines(repoRoot): string[]`.

### run.ts (runSwarm)
- `RunOptions` gets `maxCalls?` and `maxMinutes?`. Export `EXIT_FAILED=1`, `EXIT_WAITING=2`, `EXIT_BUDGET=3`.
- The agent command is `resolveAgentCommand(config, 'worker', opts.agentCommand)`.
- Agent env additionally gets `BASTION_CLI` (absolute path of the built cli.js) and `BASTION_HOME` (main repo root).
- run-state keeps agentCalls, accumulatedMinutes (across --resume), blockedNodes, budgetHit.
- Before every agent attempt check the budget; after every attempt collect the outbox: decisions -> appendDecisions,
  questions -> openQuestions; a node that asked is paused (not retried, not merged).
- On --resume, answered questions for a node are appended to its prompt.

### gate.ts
- After the integrity check, run the BASELINE config's `checks` (runPreChecks / runPreChecksAsync) before testCommand; a failing check fails the gate and names the command.

### CLI (src/cli.ts) and init
- New commands: `decide --title --chosen --why [--undo] [--node]`, `ask --question [--recommend] [--node]`, `decisions`, `answer <id> "<answer>"`, `summary`; `run` gets `--max-calls` and `--max-minutes`.
- `bastion init` and .gitignore also ignore `.bastion/outbox/`, `.bastion/decisions.json`, `.bastion/inbox.json`.

### Behaviour of each feature
"""

import re
tasks_b2 = re.sub(r'\s*Edit only [^.]*\.', '', tasks)
tasks_b2 = re.sub(r'\s*Acceptance: [^\n]*', '', tasks_b2)
tasks_b2 = tasks_b2.replace('implement the TODO bodies', 'implement them')
B2 = SCAFFOLD + tasks_b2 + """

Run `npm test` and keep going until it passes. Write your own tests for the new features if you think they help.
"""

open(f'{out_dir}/b1-prompt.txt', 'w', encoding='utf8').write(B1)
open(f'{out_dir}/b2-prompt.txt', 'w', encoding='utf8').write(B2)
print(len(B1), len(B2))
