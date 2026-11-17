# Bastion (`bastion-gate`)

**Harness-agnostic multi-agent parallel development engine + hard test gate.**

> Like a fortress (*Bastion*): inside the walls, multiple AI agents work in parallel inside isolated git worktrees by dependency waves; at every exit gate, immutable red-first test locks and baseline CI checks stop agents from cheating on tests before anything merges to `main`.

- **Works with any AI CLI or model**: plug in `claude -p`, `codex exec`, Gemini/Antigravity, or any script via `agentCommand` — no vendor lock-in, no multi-model requirement
- **DAG Wave Orchestration (`plan` + `run`)**: topological waves, parallel `git worktree` isolation, concurrency throttling, automatic gate-feedback retry loops, and N-pass post-merge verification
- **Unbreakable Test Gate (`lock` + `gate` + `mutate`)**: red-first test locking, baseline-ref config enforcement, lightweight mutation spot-checks, and `audit` for local-only repos
- **Zero runtime dependencies** (`Node.js >= 18`), built with Claude & Antigravity, and **dogfooded by Bastion itself**

---

## Architecture

```
  [ .bastion/plan.json ] ──▶ Topological Waves (Wave 1, Wave 2, ...)
                                   │
          ┌────────────────────────┴────────────────────────┐
          ▼                                                 ▼
   worktree: bastion/node-a                         worktree: bastion/node-b
   1. Agent runs in isolation                       1. Agent runs in isolation
   2. `bastion gate` vs baseline                    2. `bastion gate` vs baseline
      └─ cheat/fail? feed back & retry                 └─ pass!
          │                                                 │
          └────────────────────────┬────────────────────────┘
                                   ▼
                     Merge (--no-ff) -> Verify Nx
```

## Quick Start

### 1. Single-repo Hard Gate (Stop agents from modifying tests)

```bash
# Initialize config, AGENTS.md, SKILL.md, and GitHub Action workflow
npx bastion-gate init --base main

# Write failing acceptance tests, commit them + .bastion/config.json to main
git add . && git commit -m "test: add failing acceptance tests"

# Verify tests are RED on baseline and lock them (+ print plain-language test names)
npx bastion-gate lock
git add .bastion/lock.json && git commit -m "chore: lock baseline tests"

# On any feature branch or CI PR, verify locked scope & run baseline testCommand
npx bastion-gate gate --base main
```

### 2. Multi-Agent Parallel Swarm (`plan` + `run`)

```bash
# Create a dependency-ordered task map (.bastion/plan.json)
npx bastion-gate plan --init
npx bastion-gate plan

# Run parallel agents in isolated git worktrees with hard-gate enforcement
npx bastion-gate run --agent 'claude -p "{prompt}" --permission-mode acceptEdits' --concurrency 3 --verify-runs 3
```

## Commands

- `bastion init [--test-cmd "<cmd>"] [--base <branch>] [--force]`  
  Creates `.bastion/config.json` (auto-detecting `pytest`, `go test ./...`, `cargo test`, `flutter test`, or `npm test`), `AGENTS.md` snippet, `.agents/skills/bastion-gate/SKILL.md`, and `.github/workflows/bastion.yml`.
- `bastion lock [--base <ref>] [--amend --reason "<why>"] [--allow-dirty] [files...]`  
  Runs `testCommand` on baseline, rejects green tests, locks git-tracked test files + configs/fixtures (`conftest.py`, `package.json`, `vitest.config.*`, etc.), and prints a plain-language list of locked test names.
- `bastion gate [--base <ref>]`  
  Reads config and lock from the baseline ref, verifies zero modifications to locked files or `.bastion/`, and executes `testCommand` directly.
- `bastion plan [--init] [--force]`  
  Creates or validates `.bastion/plan.json`, computes parallel execution waves, and flags tier-3 tasks awaiting human approval.
- `bastion run [--base <ref>] [--agent "<cmd>"] [--concurrency <n>] [--max-retries <n>] [--verify-runs <n>]`  
  Spawns parallel worktree workers per wave, enforces `gate` with automatic retry feedback, merges verified branches with `--no-ff`, and runs final verification N times.
- `bastion mutate [--max <n>] [files...]`  
  Lightweight mutation spot-check: injects small mutations into source files, verifies tests catch every mutant, and always restores original files.
- `bastion audit [--limit <n>]`  
  Audits recent merge commits in local-only repositories to catch any locked-scope bypasses.

## Demo & Self-Test

```bash
npm test      # Build + run end-to-end tests (including parallel worktree swarm e2e)
npm run demo  # Run the interactive 3-scenario demo in a temporary git repo
```

## License

MIT
