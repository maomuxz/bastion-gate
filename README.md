# Bastion (`bastion-gate`)

**English** | [简体中文](README.zh-CN.md)

**Red-first test gate & multi-agent parallel orchestrator for AI coding agents.**

> Like a fortress (*Bastion*): the outer wall locks your failing acceptance tests *before* coding starts and verifies every branch against the **baseline branch's** config in CI; inside the walls, multiple AI agents can work in parallel in isolated git worktrees by dependency waves.

- **Works with any AI CLI or model**: plug in Claude Code, Codex, Gemini CLI, or any script via `agentCommand` — no vendor lock-in, no multi-model requirement
- **Hard Test Gate (`init` + `lock` + `gate` + `mutate`)**: red-first & anti-fake-red locking (rejects syntax/import-error fake reds), `.bastion/acceptance.md` checklist display, baseline-ref config enforcement, lightweight mutation spot-checks, and `audit` for local-only repos
- **Parallel Swarm Engine (`plan` + `run`, advanced)**: DAG wave scheduling, isolated `git worktree` sandboxes, `setupCommand` per worktree, concurrency throttling, automatic gate-feedback retry loops, `.bastion/disputes/<nodeId>.md` human-review pause channel, and N-pass post-merge verification
- **Scope & Target Audience**: Built for engineers and leads who can review a plain-language acceptance list. Bastion guarantees your agent didn't move the goalposts — not that the goalposts were placed in the right spot. (Tip: use a separate session/model to write tests vs. implementation.)
- **Prerequisites**: **Node.js >= 18** and **Git >= 2.5** (for worktrees). Zero runtime dependencies. Built with Claude & Antigravity, and dogfooded by Bastion itself.

---

## Quick Start (Test Gate)

```bash
# 1. Initialize .bastion/config.json, .gitignore, AGENTS.md, SKILL.md, and GitHub Action
npx bastion-gate init

# 2. Write failing acceptance tests, commit them + .bastion/config.json to your base branch
git add . && git commit -m "test: add failing acceptance tests"

# 3. Verify tests are RED on baseline and lock them (+ print plain-language test names)
npx bastion-gate lock
git add .bastion/lock.json && git commit -m "chore: lock baseline tests"

# 4. On any feature branch or CI PR, verify locked scope & run baseline testCommand
npx bastion-gate gate
```

## Multi-Agent Parallel Swarm (`plan` + `run`)

> **Cost & Isolation Note**: `bastion run` invokes your `agentCommand` up to `nodes * (maxRetries + 1)` times and runs `verifyRuns` full test passes at the end. It always merges into a dedicated `bastion/run-<timestamp>` integration branch so partial failures never pollute `main`. If your test suite binds fixed ports or a shared DB, start with `--concurrency 1` (each worker receives `BASTION_NODE_ID`).

```bash
# 1. Generate a draft .bastion/plan.json from your locked test files (then commit it!)
npx bastion-gate plan --init
npx bastion-gate plan
git add .bastion/plan.json && git commit -m "chore: add execution plan"

# 2. Run parallel worktree workers (use {promptFile} or $BASTION_PROMPT for cross-platform safety)
npx bastion-gate run --setup "npm ci" --agent "claude -p < {promptFile}" --concurrency 2 --verify-runs 3
```

### Supported Agent Examples (`--agent`)

| Agent CLI | Recommended `--agent` command |
|---|---|
| **Claude Code** | `claude -p --permission-mode acceptEdits --allowedTools "Bash(node --test:*)" < {promptFile}` *(or use your test runner prefix, e.g. `Bash(pytest:*)`)* |
| **Codex CLI** | `codex exec - < {promptFile}` |
| **Node / Custom Script** | `node scripts/my-agent.mjs` (reads `BASTION_PROMPT` or `BASTION_PROMPT_FILE`) |

> **Security & Shell Note**: Running agents non-interactively with `--dangerously-skip-permissions` grants full shell/file execution inside the worktree — run it in a container, VM, or disposable environment. Avoid embedding `{prompt}` directly in shell strings; prefer `< {promptFile}` or `BASTION_PROMPT_FILE`.

### `.bastion/plan.json` Schema

```json
{
  "version": 1,
  "nodes": [
    {
      "id": "auth",
      "title": "Implement auth module",
      "prompt": "Implement src/auth to pass tests/auth.test.ts.",
      "testCommand": "npx vitest run tests/auth.test.ts",
      "dependsOn": [],
      "tier": 1
    },
    {
      "id": "billing-deploy",
      "title": "High-risk billing migration",
      "dependsOn": ["auth"],
      "tier": 3,
      "approved": true
    }
  ]
}
```

- `id`, `title`, `prompt`: node identifier, summary, and instructions passed to the agent.
- `testCommand` *(optional)*: node-scoped test command checked during `gate` inside that node's worktree; omit to run the global `testCommand`.
- `dependsOn` *(optional)*: node IDs that must pass & merge in earlier waves.
- `tier` *(optional, `1 | 2 | 3`)*: `1` = auto-run & verify, `2` = reversible design choice, `3` = irreversible/high-risk (blocked by `plan`/`run` unless `"approved": true`).

## Commands

- `bastion init [--test-cmd "<cmd>"] [--base <branch>] [--force]`  
  Auto-detects `pytest`, `go test ./...`, `cargo test`, `flutter test`, or `npm test` and current git branch; updates `.gitignore`, creates `.bastion/config.json`, `AGENTS.md`, `.agents/skills/bastion-gate/SKILL.md`, and `.github/workflows/bastion.yml`.
- `bastion lock [--base <ref>] [--amend --reason "<why>"] [--allow-dirty] [files...]`  
  Runs `testCommand` on baseline, rejects green tests, locks git-tracked test files + configs/fixtures (`conftest.py`, `package.json`, `vitest.config.*`, etc.), and prints a plain-language list of locked test names.
- `bastion gate [--base <ref>]`  
  Reads `.bastion/config.json` and `.bastion/lock.json` from the baseline ref, verifies zero modifications to locked files, and executes `testCommand` directly.
- `bastion plan [--init] [--force]`  
  Drafts `.bastion/plan.json` from locked test files or validates wave dependencies & tier-3 approvals.
- `bastion run [--base <ref>] [--agent "<cmd>"] [--setup "<cmd>"] [--concurrency <n>] [--max-retries <n>] [--verify-runs <n>] [--timeout <min>] [--resume]`  
  Spawns parallel worktree workers on a `bastion/run-*` integration branch, enforces `gate` with failure-output feedback retries, skips sensitive files like `.env`, supports `--resume` after wave failures, and verifies N times after merge.
- `bastion mutate [--max <n>] [files...]`  
  Lightweight mutation spot-check: runs inside an isolated temporary worktree (leaving your source untouched), skips auxiliary directories (`scripts/`, `examples/`, `demo/`, etc., configurable via `mutateExclude`), samples evenly across files, and reports killed vs. survived mutants.
- `bastion audit [--limit <n>]`  
  Audits recent merge commits in local-only repositories to catch any locked-scope bypasses.
- `bastion clean [--yes] [--runs]`  
  Dry-run by default: previews leftover worktrees and temporary `bastion/<node>` branches. Pass `--yes` to delete them (preserves `bastion/run-*` integration branches unless `--runs` is also passed for already-merged runs).

## Original design vs implemented

<!-- feature-matrix:start -->
| Feature | Status | What it does |
| --- | --- | --- |
| `map` | ✅ | Turns the requirement into a plan of nodes using the planner and blind roles. |
| `review` | ✅ | Shows the plan for a human to read; `--approve` records approval. |
| `scaffold` | ✅ | Creates the interface skeleton that tests and workers build on. |
| `tests` | ✅ | Has the tester role write the acceptance tests before any code exists. |
| `run` | ✅ | Runs workers per node, in single-session or swarm mode, and merges verified work. |
| `gate` | ✅ | Checks that locked files are untouched and the test command passes. |
| `lock` | ✅ | Requires red tests on the baseline, then locks the test files. |
| `mutate` | ✅ | Makes small source changes to see whether the tests notice them. |
| `audit` | ✅ | Checks recent merge commits for locked-scope bypasses. |
| `qa` | ✅ | Has the qa role review the merged result against the requirement. |
| `flow` | ✅ | Chains the steps above into one command with human touch points. |
| `summary` | ✅ | Prints a plain-language report of what was built and verified. |
| `decisions` | ✅ | Lists the reversible design choices that workers recorded. |
| `answer` | ✅ | Replies to a question a worker asked, so the run can continue. |
| `budget` | ✅ | Shows or limits the work a run is allowed to spend. |
| `checks` | ✅ | Runs the extra verification checks configured for the project. |
| `roles` | ✅ | Lets each stage use its own agent command. |
<!-- feature-matrix:end -->

## Fortress flow

`bastion flow "<requirement>"` runs the whole pipeline from one requirement: map, review, scaffold, tests, lock, run, qa and summary. It stops when it needs a person. There are four human touch points:

1. **Requirement**: you write it and pass it to `flow`.
2. **`review --approve`**: you read the plan and approve it.
3. **Answers**: if a worker asks a question, you reply with `bastion answer`.
4. **Final merge**: you merge the finished integration branch yourself.

## Config

Settings live in `.bastion/config.json`.

- `roles`: agent command per role. Roles are `planner`, `blind` (a second, independent planner), `tester`, `worker` and `qa`. A missing role falls back to `agentCommand`.
- `runMode`: `auto`, `swarm` or `single`. `single` runs nodes in one session; `swarm` runs parallel worktrees. Unset means `swarm`. The `--single` and `--swarm` flags override it.
- `singleMaxNodes`: with `runMode: "auto"`, plans of this many nodes or fewer run as `single` (default 3); larger plans use `swarm`.
- `compileSlots`: the most gate runs (compile and test) allowed at the same time across all workers.

```json
{ "runMode": "auto", "singleMaxNodes": 3, "compileSlots": 2, "roles": { "planner": "claude -p", "worker": "claude -p" } }
```

## Troubleshooting

- **Where are worker logs?** Check `.bastion/logs/<nodeId>-attempt-<n>.log`.
- **Leftover worktrees after a crash?** Run `git worktree prune` and `rm -rf .bastion/worktrees` (or `Remove-Item -Recurse -Force .bastion/worktrees` on Windows).

## License

MIT
