# Bastion Demo (15-second GIF walkthrough)

Run the self-contained demo in a temporary git repository:

```bash
npm run demo
```

It demonstrates two core scenarios:

1. **Tautological test rejected**: An agent writes `assert.equal(true, true)`. `bastion lock` runs the test command on the baseline, sees exit `0`, and refuses to lock.
2. **Test tampering blocked, real fix passes**: A real failing test is locked on `main`. On a feature branch, an agent alters the test assertion to pass — `bastion gate` detects the locked-scope diff against `main` and exits `1`. Once reverted and implemented in `src/discount.mjs`, `bastion gate` exits `0`.
