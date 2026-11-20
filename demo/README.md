# Bastion Demo

Run the self-contained demo in temporary repositories (requires only Node.js and Git):

```bash
npm run demo
```

It walks through five live scenarios:

1. **Tautological test rejected**: An agent writes `assert.equal(true, true)`. `bastion lock` runs the test command on the baseline, sees exit `0`, and refuses to lock.
2. **Test tampering blocked**: A real failing test is locked on `main`. On a feature branch, an agent alters the test assertion to pass — `bastion gate` detects the locked-scope diff against `main` and exits `1`.
3. **Genuine fix passes**: After reverting the test cheat and implementing the fix in `src/discount.mjs`, `bastion gate` exits `0`.
4. **Compact API cheatsheet extraction (`bastion sheet`)**: Scans a temporary miniature Dart UI package (pure text parsing, no Dart SDK needed) and prints the extracted public signatures, `ThemeExtension` tokens, and `static` utility methods.
5. **Compile + locked-rule bare gate (`bastion check`)**: Runs `node --check` plus a locked rule script in three steps — flags a forbidden `eval()` call with a bare `file:line [rule]` report (fix hints stripped), catches and aborts an attempt to edit the locked rule script, and passes once the rule script is restored and the source file is fixed.
