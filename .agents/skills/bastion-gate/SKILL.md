---
name: bastion-gate
description: Enforce red-first test locking and immutable test gates with Bastion. Use before implementing features or claiming completion.
---

# Bastion Gate Workflow

1. **Red-first lock**: Write failing acceptance tests first, commit them to the baseline branch, and run `bastion lock` (must fail on baseline to be accepted).
2. **Implement without touching tests**: Write production code only. Never edit locked tests, test configs, fixtures, or `.bastion/`.
3. **Verify through the gate**: Run `bastion gate` before finishing. CI will re-run `bastion gate` against the baseline branch; local passes alone do not merge.
4. **Test defects**: If a locked test is genuinely wrong, stop and ask a human to confirm `bastion lock --amend --reason "..."`.
