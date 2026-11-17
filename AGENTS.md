<!-- bastion-gate:start -->
## Test Gate (Bastion)

- Tests and test-related configs/fixtures are locked by Bastion (`.bastion/lock.json`).
- **Do not** modify locked test files, test configs, fixtures, or `.bastion/` to make checks pass.
- If a locked test itself has a defect, stop and report it as `test_defect` for human confirmation.
- Before claiming work is done, run `npx bastion-gate gate` (or `bastion gate`).
<!-- bastion-gate:end -->
