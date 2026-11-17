# Bastion (`bastion-gate`)

**Test-locking & hard-gate CLI for AI coding agents.**  
Works with Claude Code, Cursor, Codex, Antigravity, or any agent harness — zero runtime dependencies, no multi-model requirement.

## Core Principles

1. **Local warns, CI enforces**: Local receipts or Git hooks can be bypassed (`--no-verify`, fast-forward). Real enforcement comes from **branch protection + CI re-running `bastion gate`** against the baseline branch. For local-only repos without CI, run `bastion audit` to inspect merge history.
2. **Red-first lock**: `bastion lock` runs your test suite on the baseline and **refuses to lock if tests already pass** (blocking tautological/placeholder tests).
3. **Baseline config enforcement**: `bastion gate` reads `.bastion/config.json` and `.bastion/lock.json` directly from the **baseline ref** (`git show`), so a PR branch cannot weaken `testCommand` or locked globs.

## Quick Start

```bash
# 1. Initialize Bastion config, AGENTS.md, SKILL.md, and GitHub Action workflow
npx bastion-gate init --test-cmd "npm test" --base main

# 2. Write failing acceptance tests, commit them + .bastion/config.json to main
git add . && git commit -m "test: add failing acceptance tests"

# 3. Verify tests are RED on baseline and lock them (+ print plain-language test names)
npx bastion-gate lock
git add .bastion/lock.json && git commit -m "chore: lock baseline tests"

# 4. Agents implement features on a branch, then verify through the gate
npx bastion-gate gate --base main
```

## Commands

- `bastion init [--test-cmd "<cmd>"] [--base <branch>] [--force]`  
  Creates `.bastion/config.json` (auto-detecting `pytest`, `go test ./...`, `cargo test`, `flutter test`, or `npm test`), `AGENTS.md` snippet, `.agents/skills/bastion-gate/SKILL.md`, and `.github/workflows/bastion.yml`.
- `bastion lock [--base <ref>] [--amend --reason "<why>"] [--allow-dirty] [files...]`  
  Runs `testCommand` on baseline, rejects green tests, locks git-tracked test files + configs/fixtures (`conftest.py`, `package.json`, `vitest.config.*`, etc.), and prints a plain-language list of locked test names.
- `bastion gate [--base <ref>]`  
  Reads config and lock from the baseline ref, verifies zero modifications to locked files or `.bastion/`, and executes `testCommand` directly.
- `bastion mutate [--max <n>] [files...]`  
  Lightweight mutation spot-check: injects small mutations into source files, verifies tests catch every mutant, and always restores original files.
- `bastion audit [--limit <n>]`  
  Audits recent merge commits in local-only repositories to catch any locked-scope bypasses.

## Demo & Self-Test

```bash
npm test   # Build + run end-to-end tests
npm run demo  # Run the 2-scenario interactive demo in a temp git repo
```

## License

MIT
