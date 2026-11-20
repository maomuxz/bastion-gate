import json


def before(p, anchor, text):
    s = open(p, encoding='utf8', newline='').read()
    crlf = '\r\n' in s
    s = s.replace('\r\n', '\n')
    assert s.count(anchor) == 1, (p, anchor, s.count(anchor))
    s = s.replace(anchor, text + anchor, 1)
    open(p, 'w', encoding='utf8', newline='').write(s.replace('\n', '\r\n') if crlf else s)


before('src/commands/tests.ts', 'export async function runTests(', '''/*
 * v1.1 hardening (round 5) - "a skipped or failed wall step must never look like a pass". These rules replace the
 * older wording above wherever they differ.
 * (H1) lock requested, gaps not disabled (opts.gaps !== false), but .bastion/requirement.md is missing or blank:
 *      no critic is called (as before), and the skip is now loud and recorded: stderr gets
 *      `[bastion] tests: no .bastion/requirement.md - the gap check was skipped; locking without it.` and
 *      .bastion/gaps.md is written with exactly
 *      `# Gap check\\n\\nSkipped: no .bastion/requirement.md, so there was nothing to check the tests against.\\n`
 *      and committed together with the lock like a normal gaps.md (when git does not ignore it). Exit code as before.
 *      With opts.gaps === false nothing is printed and gaps.md is not touched.
 * (H2) After each gap-patch tester call (label tests-<id>-gaps), before anything is committed or locked:
 *      - the node's test file must still contain every test case name it had before (listTestCases); otherwise stderr
 *        `[bastion] tests: gap patch for <id> removed test case(s) from <file>: <names joined by ', '>.` and return 1;
 *      - it must contain strictly more cases than before; otherwise stderr
 *        `[bastion] tests: gap patch for <id> added no test case to <file>.` and return 1 (this also covers an
 *        unchanged file and a comment-only change; the older "left ... unchanged" message is no longer used);
 *      - every other test file of the map must be byte-identical to what it was before this tester call; otherwise
 *        stderr `[bastion] tests: gap patch for <id> changed another node's test file: <that file>.` and return 1.
 *      The note in gaps.md becomes
 *      `Patched by the tester: <ids joined by ', '> (<n> new case(s)). The patch was not re-checked by the critic.`
 *      where n is the total number of cases added over all patched files.
 * (H3) Dependency scan: any exception (unreadable plan, write failure...) prints
 *      `[bastion] tests: dependency scan failed: <message>` to stderr and returns 1 - nothing is committed or locked.
 *      A reported cycle (the existing "fix the map" line) also returns 1 after all cycle lines were printed.
 */
''')

before('src/commands/qa.ts', 'export async function runQa(', '''/*
 * v1.1 hardening (round 5). These rules replace the older wording above wherever they differ.
 * (Q1) The qa role must not change the checkout it judges. After the role returned 0 and before its report is read or
 *      any case is run, bastion runs `git status --porcelain` (untracked files included) in the QA worktree. Any path
 *      outside `.bastion/` (modified, deleted, added or untracked) ->
 *      stderr `[bastion] qa: the qa role changed files in the checkout: <up to 5 paths joined by ', '>. QA must not edit the product; no case was run.`
 *      and return 1. No case is run, no qa-run.json is written, no feedback file is written and run-state is untouched.
 *      Files under `.bastion/` (the report, .bastion/qa-cases/...) are allowed.
 * (Q2) The role's verdict counts again. When the merged findings list is empty (no finding in the report, every case
 *      exited 0) but report.verdict is 'fail' -> stderr
 *      `[bastion] qa: the qa role's verdict is fail but it reported no finding; read .bastion/qa-report.json.`
 *      and return 1 (qa-report.json and qa-run.json are still written; no feedback, run-state untouched).
 *      A 'pass' verdict with a failing case is still a failure with a code finding, as before.
 */
''')

before('src/gaps.ts', '/**\n * Split gaps by whether their quote really occurs in the requirement.', '''/*
 * v1.1 hardening (round 5) of checkQuotes - a real gap must not be thrown away because the critic quoted sloppily:
 * - both sides are normalised with String.prototype.normalize('NFKC') (full-width punctuation and letters become
 *   ASCII), lower-cased, and then every whitespace character and every one of these characters is removed:
 *   * _ ` ~ # > | " ' and the curly quotes (U+201C U+201D U+2018 U+2019);
 * - a quote may shorten the requirement with an ellipsis: it is split at every `...` (three or more dots) and every
 *   U+2026; it is kept when it has at least one non-empty piece and every non-empty piece occurs in the requirement,
 *   each one after the end of the previous piece (in order, not overlapping);
 * - a quote that is empty after normalisation is discarded.
 * Everything else (order preserved, kept / discarded) is unchanged.
 */
''')

before('src/commands/gaps.ts', 'export async function findGaps(', '''/*
 * v1.1 hardening (round 5), normal mode (not probe):
 * - when the critic reported at least one gap and checkQuotes discarded ALL of them, the check did not happen in any
 *   useful sense: findGaps returns { ok: false, error: `critic reported <n> gap(s) but none of them quotes the requirement; the gap check does not count.` }
 *   (callers already print the error and return 1; nothing gets locked);
 * - when only some were discarded, findGaps prints to stderr
 *   `[bastion] gaps: <n> reported gap(s) dropped because their quote is not in the requirement.` and goes on as before.
 * A report with zero gaps is still ok with kept [] and discarded [].
 */
''')

before('src/runner.ts', '/** Async version of runTestCommand', '''/**
 * v1.1 hardening (round 5): terminate a process and everything it started. Windows: `taskkill /PID <pid> /T /F`
 * (synchronous, errors ignored). Elsewhere: SIGKILL to the process group `-pid` (the process must have been started
 * with `detached: true`), falling back to the single pid. Never throws, also for a pid that no longer exists.
 */
export function killProcessTree(pid: number): void {
  void pid; // TODO(v1.1 r5)
}

/*
 * v1.1 hardening (round 5) of runTestCommandAsync: on timeout the whole process tree is terminated with
 * killProcessTree (on POSIX the command is therefore spawned with detached: true), not just the shell, and the promise
 * resolves within about 5 seconds after the timeout even when some surviving process still holds the output pipes
 * (do not wait for 'close' forever). Result on timeout as before: exitCode 124 and the "timed out after" line.
 * A command that finishes in time behaves exactly as before.
 */
''')

before('src/commands/run.ts', 'export async function runSwarm(', '''/*
 * v1.1 hardening (round 5). These rules replace the older wording above wherever they differ.
 * (g) Single mode feedback. In single mode the one agent session builds every plan node, so its prompt must carry the
 *     feedback written for ANY of them: the QA / reopen feedback section contains, for every plan node (plan order)
 *     that has a non-empty .bastion/feedback/<id>.md, a line `### <id>` followed by that file's content, plus the
 *     content of .bastion/feedback/all-nodes.md when it exists. (Before, only all-nodes.md was read, so
 *     `bastion reopen <node> --reason ...` and QA findings never reached the agent.) The files are deleted after the
 *     gate passed, as before. Swarm mode is unchanged (each node reads its own file).
 * (h) Agent timeout. When an agent call times out, the whole process tree is terminated with killProcessTree from
 *     ../runner.js (POSIX: spawn detached), and the call resolves within about 5 seconds after the timeout even if a
 *     surviving process keeps the pipes open. The attempt is reported as timed out exactly as before.
 */
''')

p = 'docs/dogfood/v1.1/tester-nodes.json'
d = json.load(open(p, encoding='utf8'))
d['r5'] = {
 "tests": {"write": ["v11-hard-tests.test.ts"], "update": ["v11-tests-gaps.test.ts"],
  "updateNote": "v11-tests-gaps.test.ts was written against the older rules. Change only assertions that contradict (H1)-(H3): e.g. a fixture whose gap patch merely edits the file without adding a case must now add a real new case; the 'left ... unchanged' message is replaced by 'added no test case'; the gaps.md note text has the `(<n> new case(s))` part. Keep everything else.",
  "files": "the 'v1.1 hardening (round 5)' comment above runTests in src/commands/tests.ts (H1, H2, H3)",
  "extra": "Model it on tests/v11-tests-gaps.test.ts (same helpers and fixtures; read it first). H1: no requirement file and a blank one, with lock: no critic call, the stderr line, exact gaps.md content, gaps.md is in the lock commit, exit 0 and the lock exists; with gaps:false: no line and no gaps.md. H2, each as its own case, each asserting return 1, the exact stderr line, no lock.json and no new commit: patch only adds a comment; patch replaces one case by another (same count); patch adds one case but removes/renames an old one (names listed); patch adds a case to its own file but also edits another node's test file; and the good path: patch adds two cases -> 0 and the gaps.md note says `(2 new case(s))`. H3: make the scan throw by writing an unparsable .bastion/plan.json (commit it so the tree is clean) -> return 1, the stderr line, nothing locked; a cycle (the map says n1 dependsOn n2 while n2's test imports a file owned by n1... build the smallest such map) -> the cycle line and return 1."},
 "qa": {"write": ["v11-hard-qa.test.ts"],
  "files": "the 'v1.1 hardening (round 5)' comment above runQa in src/commands/qa.ts (Q1, Q2)",
  "extra": "Model it on tests/v11-qa.test.ts (read it first: how the qa fixture writes case scripts under .bastion/qa-cases and the report). Q1: a qa fixture that also modifies a tracked product file in its cwd, one that adds an untracked file outside .bastion, one that deletes a tracked file -> each returns 1 with the stderr line naming the path, no .bastion/qa-run.json, no feedback file, run-state completedNodes unchanged; a fixture that only writes under .bastion/ still passes. Important: the case scripts in the tampering fixture must pass ONLY thanks to the tampering (so that without Q1 the run would wrongly return 0). Q2: report { verdict: 'fail', findings: [], cases: [one passing case] } -> return 1 with the stderr line, qa-run.json and qa-report.json written, no feedback file; { verdict: 'pass', findings: [], cases: [passing] } -> 0."},
 "gaps": {"write": ["v11-hard-gaps.test.ts"],
  "files": "the 'v1.1 hardening (round 5)' comments above checkQuotes in src/gaps.ts and above findGaps in src/commands/gaps.ts",
  "extra": "checkQuotes is pure: cover full-width vs ASCII punctuation in a Chinese requirement, markdown markers (**bold**, `code`, table pipes, list/heading/quote markers) present on one side only, curly vs straight quotes, an ellipsis quote with `...` and with the U+2026 character (kept when the pieces occur in order; discarded when a piece is missing or the pieces occur in the wrong order), a quote that is only markers/whitespace (discarded), an invented quote (discarded), order preserved. findGaps / runGaps: model on tests/v11-gaps-cmd.test.ts: critic reports 2 gaps with invented quotes -> findGaps ok false with the exact error, runGaps returns 1; critic reports one good and one invented -> ok true, kept 1, discarded 1 and the stderr line with n = 1; zero gaps -> ok true and no stderr line."},
 "run": {"write": ["v11-hard-run.test.ts"],
  "files": "killProcessTree and the round 5 comment above runTestCommandAsync in src/runner.ts; items (g) and (h) of the 'v1.1 hardening (round 5)' comment above runSwarm in src/commands/run.ts",
  "extra": "(g) model on tests/v11-run-fixes.test.ts / tests/v04-helpers.ts createSwarmRepo (read how an agent script can save the prompt it received to a file). Run with mode 'single' and two plan nodes; before the run write .bastion/feedback/<second node id>.md with a distinctive sentence (as `bastion reopen` would) - the agent's prompt must contain `### <id>` and the sentence; a node without a feedback file gets no heading; after a passing run the feedback file is gone. In swarm mode a node's prompt contains only its own feedback. killProcessTree: start a node process that starts a never-ending child node process (child writes its pid to a file), call killProcessTree(parent.pid), then poll up to 5 s until process.kill(childPid, 0) throws; calling it for a pid that does not exist does not throw. runTestCommandAsync: a command that starts a never-ending grandchild which inherits stdout, timeout 1500 ms -> resolves in under 15 s with exitCode 124 and the grandchild is gone (same pid-file polling). (h): an agent command that starts a never-ending grandchild and waits, with a very small timeout (timeoutMinutes 0.03) and maxRetries 0: runSwarm returns (does not hang; give the test a 120 s timeout), the node is not completed, and the grandchild is gone afterwards."},
}
open(p, 'w', encoding='utf8', newline='\n').write(json.dumps(d, indent=2, ensure_ascii=False) + '\n')

p = 'docs/dogfood/v1.1/plan-nodes.json'
d = json.load(open(p, encoding='utf8'))
d['r5'] = {"nodes": [
 {"id": "h1-tests", "title": "No silent skip or fake patch before the lock", "files": "src/commands/tests.ts", "tests": ["v11-hard-tests.test.ts", "v11-tests-gaps.test.ts"], "task": "Implement (H1), (H2) and (H3) of the 'v1.1 hardening (round 5)' comment above runTests in src/commands/tests.ts."},
 {"id": "h2-qa", "title": "QA cannot edit the product; a fail verdict counts", "files": "src/commands/qa.ts", "tests": ["v11-hard-qa.test.ts"], "task": "Implement (Q1) and (Q2) of the 'v1.1 hardening (round 5)' comment above runQa in src/commands/qa.ts."},
 {"id": "h3-gaps", "title": "Sloppy quotes are matched; all-discarded is not a pass", "files": "src/gaps.ts and src/commands/gaps.ts", "tests": ["v11-hard-gaps.test.ts"], "task": "Implement the 'v1.1 hardening (round 5)' comments above checkQuotes in src/gaps.ts and above findGaps in src/commands/gaps.ts."},
 {"id": "h4-run", "title": "Single-mode feedback reaches the agent; timeouts kill the process tree", "files": "src/runner.ts and src/commands/run.ts", "tests": ["v11-hard-run.test.ts"], "task": "Implement killProcessTree and the round 5 hardening of runTestCommandAsync in src/runner.ts, and items (g) and (h) of the 'v1.1 hardening (round 5)' comment above runSwarm in src/commands/run.ts."},
]}
open(p, 'w', encoding='utf8', newline='\n').write(json.dumps(d, indent=2) + '\n')
print('ok6')

before('src/commands/audit.ts', 'export function runAudit(', '''/*
 * v1.1 hardening (round 5): a merge that cannot be checked is no longer skipped without a trace.
 * - A merge whose first parent has no readable .bastion config or lock prints
 *   `[SKIP] <first 8 chars of the sha> (<subject>) - its parent has no readable bastion config/lock` (same shape as
 *   the [PASS] lines).
 * - After the loop, when at least one merge was skipped and there was no failure, one more line follows the usual
 *   final line: `[bastion] Audit: <checked> merge(s) checked, <skipped> skipped (not covered by this audit).`
 * - When EVERY merge was skipped, the usual "no locked-scope bypasses detected" line is NOT printed (nothing was
 *   checked); instead `[bastion] Audit: no merge could be checked (<n> skipped).` is printed. Exit code stays 0.
 * With no skipped merge the output is exactly as before.
 */
''')
p = 'docs/dogfood/v1.1/tester-nodes.json'
d = json.load(open(p, encoding='utf8'))
d['r5']['audit'] = {"write": ["v11-hard-audit.test.ts"], "files": "the 'v1.1 hardening (round 5)' comment above runAudit in src/commands/audit.ts",
  "extra": "Model it on the audit tests in tests/v1-audit-amend.test.ts or tests/bastion.test.ts (read how they build a repo with merges). Cases: a repo whose only merge happened before `bastion init`/lock -> the [SKIP] line, the 'no merge could be checked (1 skipped)' line, NOT the 'no locked-scope bypasses detected' line, exit 0; one merge before the lock and one clean merge after -> the SKIP line, the usual final line, then the '1 merge(s) checked, 1 skipped' line; only checked merges -> output has no SKIP and no extra line; a bypass after the lock plus a skipped merge -> still exit 1 and the bypass is reported."}
open(p, 'w', encoding='utf8', newline='\n').write(json.dumps(d, indent=2, ensure_ascii=False) + '\n')
p = 'docs/dogfood/v1.1/plan-nodes.json'
d = json.load(open(p, encoding='utf8'))
d['r5']['nodes'].append({"id": "h5-audit", "title": "Audit says what it could not check", "files": "src/commands/audit.ts", "tests": ["v11-hard-audit.test.ts"], "task": "Implement the 'v1.1 hardening (round 5)' comment above runAudit in src/commands/audit.ts."})
open(p, 'w', encoding='utf8', newline='\n').write(json.dumps(d, indent=2) + '\n')
print('ok6b')
