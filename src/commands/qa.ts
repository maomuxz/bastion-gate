import * as fs from 'node:fs';
import * as path from 'node:path';
import { readConfigFromDisk } from '../config.js';
import { execGit, getRepoRoot } from '../git.js';
import { resolveAgentCommand, runRole } from '../roles.js';
import { runTestCommand, runTestCommandAsync } from '../runner.js';
import { readRunState, writeRunState } from '../state.js';
// The wall: kernel files must not import src/commands/stages.ts (it reaches add-on modules), so the shapes and paths
// it shares are declared here; they are structurally identical to the ones in stages.ts.
interface QaOptions { cwd: string; timeoutMinutes?: number; ref?: string }
interface QaFinding { node: string; kind: 'code' | 'test_defect'; issue: string }
interface QaCase { name: string; rule: string; node: string; command: string }
interface QaCaseRun extends QaCase { exitCode: number; timedOut: boolean; outputTail: string }
interface QaReport { verdict: 'pass' | 'fail'; findings: QaFinding[]; cases: QaCase[] }
const QA_REPORT_REL_PATH = '.bastion/qa.json';
const QA_DISPUTES_REL_PATH = '.bastion/qa-disputes.md';
const QA_RUN_REL_PATH = '.bastion/qa-run.json';
const QA_CASES_REL_DIR = '.bastion/qa-cases';
const REQUIREMENT_REL_PATH = '.bastion/requirement.md';

const CASE_TIMEOUT_MS = 60_000;

/**
 * P7: validate an untrusted QA report; null when invalid (verdict must be pass|fail, findings an array of {node, kind, issue}).
 * v1.1: `cases` is an optional array of { name, rule, node, command } - all four non-empty strings, else the whole report
 * is invalid; a missing `cases` key gives []; a `cases` value that is not an array is invalid.
 */
export function parseQaReport(raw: unknown): QaReport | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.verdict !== 'pass' && r.verdict !== 'fail') return null;
  if (!Array.isArray(r.findings)) return null;
  const findings: QaFinding[] = [];
  for (const f of r.findings) {
    if (typeof f !== 'object' || f === null || Array.isArray(f)) return null;
    const o = f as Record<string, unknown>;
    if (typeof o.node !== 'string' || typeof o.issue !== 'string') return null;
    if (o.kind !== 'code' && o.kind !== 'test_defect') return null;
    findings.push({ node: o.node, kind: o.kind, issue: o.issue });
  }
  const cases: QaCase[] = [];
  if (r.cases !== undefined) {
    if (!Array.isArray(r.cases)) return null;
    for (const c of r.cases) {
      if (typeof c !== 'object' || c === null || Array.isArray(c)) return null;
      const o = c as Record<string, unknown>;
      const { name, rule, node, command } = o;
      if (typeof name !== 'string' || name === '') return null;
      if (typeof rule !== 'string' || rule === '') return null;
      if (typeof node !== 'string' || node === '') return null;
      if (typeof command !== 'string' || command === '') return null;
      cases.push({ name, rule, node, command });
    }
  }
  return { verdict: r.verdict, findings, cases };
}

/**
 * P7 `bastion qa [--ref <ref>]`.
 *
 * v1.1 kernel rule - works without a map, a plan or a run:
 *  - Target: with a run-state and no `ref`, the run's integration branch and baseRef (as before). With `ref`, or without a
 *    run-state, the target is `ref ?? 'HEAD'` and the base is config.baseBranch; this is "standalone" mode.
 *  - .bastion/acceptance.md is optional: when it is missing the `## Acceptance (acceptance.md)` section is left out.
 *  - In standalone mode nothing is reopened and run-state is neither read for nodes nor written; 'code' findings are
 *    still appended to .bastion/feedback/<node>.md and the last stderr line is
 *    `[bastion] qa: fix the findings, then run bastion qa again.` instead of the `run --resume` hint.
 *  - When `git diff --stat <base>...<target>` fails (e.g. the base branch does not exist) the `## Changed files` section
 *    contains the single line `(unavailable)`; this is not an error.
 *  A missing run-state is therefore no longer an error.
 *
 * v1.1 - QA really runs the product instead of reading a cut diff:
 * 1. Checkout: create a detached worktree of the integration branch at .bastion/worktrees/qa (remove a stale one first);
 *    when config.setupCommand is set, run it there (non-zero -> 1). The worktree is always removed before returning.
 * 2. Prompt (role 'qa', label 'qa', cwd = the worktree, outputPath = <worktree>/.bastion/qa.json). It contains:
 *    `## Original requirement (source of truth)` with .bastion/requirement.md of the main checkout verbatim (section left
 *    out when the file is missing or blank); `## Acceptance (acceptance.md)`; `## Changed files` with the output of
 *    `git diff --stat <baseRef>...<integrationBranch>` (never the full diff). It tells the role: you are in a checkout of
 *    the integrated code; write black-box case scripts under .bastion/qa-cases/ that use the product the way a user
 *    would (CLI or public API) and exit 0 only when the behaviour matches the requirement; run every case yourself;
 *    prefer rules of the requirement that the existing tests do not check; do not edit product or test files; report
 *    {"verdict","findings":[{node,kind,issue}],"cases":[{"name","rule","node","command"}]} where command is run from the
 *    checkout root.
 * 3. Role exit != 0 or invalid report -> 1. A report with no case -> stderr
 *    `[bastion] qa: the qa role ran no black-box case.` and 1 (a pass without evidence is not accepted).
 * 4. Bastion runs every case command itself in the worktree (shell, 60 s timeout each, sequentially) and writes the
 *    QaCaseRun[] (outputTail = last 2000 chars of stdout+stderr) to .bastion/qa-run.json of the main checkout. It copies
 *    <worktree>/.bastion/qa-cases/ to .bastion/qa-cases/ of the main checkout (replacing an old copy) and the report to
 *    .bastion/qa.json.
 * 5. Verdict: every case that exits non-zero or times out adds a finding { node: case.node, kind: 'code',
 *    issue: 'black-box case "<name>" failed (<rule>): <command> exited <code>' plus the output tail } unless the report
 *    already has a 'code' finding for that node. The run passes (0, prints `[bastion] qa: pass (<n> case(s) run).`) only
 *    when there is no finding at all - the role's own verdict cannot override a failing case or an existing finding.
 * fail -> for each 'code' finding: remove the node from run-state completedNodes and append the
 * issue to .bastion/feedback/<node>.md (bastion run --resume feeds it to the agent); 'test_defect' findings are listed in
 * .bastion/qa-disputes.md for a human (lock --amend). Returns 1 and prints what to do next.
 */
/*
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
export async function runQa(opts: QaOptions): Promise<number> {
  const repoRoot = getRepoRoot(opts.cwd);
  if (!repoRoot) {
    console.error('[bastion] Error: not inside a git repository.');
    return 1;
  }
  const runState = readRunState(repoRoot);
  const state = opts.ref !== undefined || !runState ? null : runState;
  const acceptancePath = path.join(repoRoot, '.bastion', 'acceptance.md');
  const acceptance = fs.existsSync(acceptancePath) ? fs.readFileSync(acceptancePath, 'utf8') : null;
  let config;
  try {
    config = readConfigFromDisk(repoRoot);
  } catch (e) {
    console.error(`[bastion] Error: ${(e as Error).message}`);
    return 1;
  }
  const command = resolveAgentCommand(config, 'qa');
  if (!command) {
    console.error('[bastion] Error: no qa command configured (roles.qa or agentCommand).');
    return 1;
  }
  const target = state ? state.integrationBranch : (opts.ref ?? 'HEAD');
  const base = state ? state.baseRef : config.baseBranch;
  const statRes = execGit(['diff', '--stat', `${base}...${target}`], repoRoot);
  const changed = statRes.ok ? statRes.stdout : '(unavailable)';
  let requirement = '';
  try {
    requirement = fs.readFileSync(path.join(repoRoot, REQUIREMENT_REL_PATH), 'utf8');
  } catch {
    requirement = '';
  }

  const wtDir = path.join(repoRoot, '.bastion', 'worktrees', 'qa');
  const removeWt = (): void => {
    if (fs.existsSync(wtDir)) {
      execGit(['worktree', 'remove', '--force', wtDir], repoRoot);
      if (fs.existsSync(wtDir)) fs.rmSync(wtDir, { recursive: true, force: true });
    }
    execGit(['worktree', 'prune'], repoRoot);
  };
  removeWt();
  fs.mkdirSync(path.dirname(wtDir), { recursive: true });
  const add = execGit(['worktree', 'add', '--detach', wtDir, target], repoRoot);
  if (!add.ok) {
    console.error(`[bastion] qa: could not create the QA worktree: ${add.stderr}`);
    return 1;
  }

  const reportFailure = (findings: QaFinding[]): number => {
    const code = findings.filter((f) => f.kind === 'code');
    const defects = findings.filter((f) => f.kind === 'test_defect');
    if (code.length > 0) {
      if (state) {
        const reopened = new Set(code.map((f) => f.node));
        writeRunState(repoRoot, { ...state, completedNodes: state.completedNodes.filter((n) => !reopened.has(n)) });
      }
      const dir = path.join(repoRoot, '.bastion', 'feedback');
      fs.mkdirSync(dir, { recursive: true });
      for (const f of code) {
        const file = path.join(dir, `${path.basename(f.node)}.md`);
        const prev = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
        const sep = prev && !prev.endsWith('\n') ? '\n' : '';
        fs.writeFileSync(file, `${prev}${sep}- ${f.issue.trimEnd()}\n`, 'utf8');
      }
    }
    if (defects.length > 0) {
      const file = path.join(repoRoot, QA_DISPUTES_REL_PATH);
      const prev = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '# QA disputes\n\n';
      const lines = defects.map((f) => `- ${f.node}: ${f.issue}`).join('\n');
      fs.writeFileSync(file, `${prev}${prev.endsWith('\n') ? '' : '\n'}${lines}\n`, 'utf8');
    }
    console.error(`[bastion] qa: fail (${code.length} code finding(s), ${defects.length} test defect(s)).`);
    if (code.length > 0) {
      if (state) console.error(`[bastion] qa: reopened ${[...new Set(code.map((f) => f.node))].join(', ')}. Next: bastion run --resume`);
      else console.error('[bastion] qa: fix the findings, then run bastion qa again.');
    }
    if (defects.length > 0) {
      console.error(`[bastion] qa: test defects listed in ${QA_DISPUTES_REL_PATH}. Next: review them, then bastion lock --amend.`);
    }
    return 1;
  };

  const inWorktree = async (): Promise<number> => {
    if (config.setupCommand) {
      const setup = runTestCommand(config.setupCommand, wtDir);
      if (setup.exitCode !== 0) {
        console.error(`[bastion] qa: setupCommand failed in the QA worktree (exit ${setup.exitCode}).`);
        return 1;
      }
    }
    // Paths outside .bastion/ that are already dirty (e.g. setupCommand output) are not the role's doing.
    const dirtyPaths = (): string[] | null => {
      const st = execGit(['status', '--porcelain', '--untracked-files=all'], wtDir);
      if (!st.ok) return null;
      const out: string[] = [];
      for (const line of st.stdout.split(/\r?\n/)) {
        if (line.length < 4) continue;
        const raw = line.slice(3);
        const arrow = raw.indexOf(' -> ');
        for (let p of arrow >= 0 ? [raw.slice(0, arrow), raw.slice(arrow + 4)] : [raw]) {
          if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
          if (p === '.bastion' || p.startsWith('.bastion/')) continue;
          if (!out.includes(p)) out.push(p);
        }
      }
      return out;
    };
    const baselineDirty = dirtyPaths() ?? [];
    const prompt = [
      'You are the QA reviewer. You are in a checkout of the integrated code. Use the product the way a user would.',
      `Write black-box case scripts under ${QA_CASES_REL_DIR}/ that use the product (CLI or public API) and exit 0 only when the behaviour matches the requirement.`,
      'Run every case yourself. Prefer rules of the requirement that the existing tests do not check.',
      'Do not edit product or test files.',
      `Write a JSON report to ${QA_REPORT_REL_PATH} (the BASTION_OUTPUT path) of the form:`,
      '{"verdict":"pass"|"fail","findings":[{"node":"<node id>","kind":"code"|"test_defect","issue":"<what is wrong>"}],"cases":[{"name":"<case name>","rule":"<rule it checks>","node":"<node id>","command":"<shell command, run from the checkout root>"}]}',
      'Use kind "code" when the implementation is wrong, "test_defect" when the locked test itself is wrong.',
      'A pass verdict must have an empty findings array. Report at least one case.',
      '',
      ...(requirement.trim() ? ['## Original requirement (source of truth)', requirement, ''] : []),
      ...(acceptance !== null ? ['## Acceptance (acceptance.md)', acceptance, ''] : []),
      '## Changed files',
      changed,
      '',
    ].join('\n');

    const reportPath = path.join(wtDir, QA_REPORT_REL_PATH);
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.rmSync(reportPath, { force: true });
    const timeoutMs = opts.timeoutMinutes && opts.timeoutMinutes > 0 ? opts.timeoutMinutes * 60_000 : undefined;
    const res = await runRole(command, 'qa', {
      prompt,
      cwd: wtDir,
      repoRoot,
      label: 'qa',
      outputPath: reportPath,
      timeoutMs,
    });
    if (res.exitCode !== 0) {
      console.error(`[bastion] qa: qa role ${res.timedOut ? 'timed out' : `exited ${res.exitCode}`}.`);
      return 1;
    }
    const afterRole = dirtyPaths();
    if (afterRole) {
      const changedPaths = afterRole.filter((p) => !baselineDirty.includes(p));
      if (changedPaths.length > 0) {
        console.error(
          `[bastion] qa: the qa role changed files in the checkout: ${changedPaths.slice(0, 5).join(', ')}. QA must not edit the product; no case was run.`
        );
        return 1;
      }
    }
    let report: QaReport | null = null;
    try {
      report = parseQaReport(JSON.parse(fs.readFileSync(reportPath, 'utf8').replace(/^﻿/, '')));
    } catch {
      report = null;
    }
    if (!report) {
      console.error(`[bastion] qa: the qa role did not write a valid report to ${QA_REPORT_REL_PATH}.`);
      return 1;
    }
    if (report.cases.length === 0) {
      console.error('[bastion] qa: the qa role ran no black-box case.');
      return 1;
    }

    const runs: QaCaseRun[] = [];
    for (const c of report.cases) {
      const r = await runTestCommandAsync(c.command, wtDir, CASE_TIMEOUT_MS);
      const timedOut = r.exitCode === 124 && r.stderr.includes('timed out after');
      runs.push({ ...c, exitCode: r.exitCode, timedOut, outputTail: (r.stdout + r.stderr).slice(-2000) });
    }
    fs.mkdirSync(path.join(repoRoot, '.bastion'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, QA_RUN_REL_PATH), JSON.stringify(runs, null, 2), 'utf8');
    const casesDest = path.join(repoRoot, QA_CASES_REL_DIR);
    fs.rmSync(casesDest, { recursive: true, force: true });
    const casesSrc = path.join(wtDir, QA_CASES_REL_DIR);
    if (fs.existsSync(casesSrc)) fs.cpSync(casesSrc, casesDest, { recursive: true });
    fs.writeFileSync(path.join(repoRoot, QA_REPORT_REL_PATH), JSON.stringify(report, null, 2), 'utf8');

    const reportCodeNodes = new Set(report.findings.filter((f) => f.kind === 'code').map((f) => f.node));
    const findings: QaFinding[] = [...report.findings];
    for (const run of runs) {
      if (run.exitCode === 0 && !run.timedOut) continue;
      if (reportCodeNodes.has(run.node)) continue;
      const how = run.timedOut ? 'timed out' : `exited ${run.exitCode}`;
      findings.push({
        node: run.node,
        kind: 'code',
        issue: `black-box case "${run.name}" failed (${run.rule}): ${run.command} ${how}\n${run.outputTail}`.trimEnd(),
      });
    }
    if (findings.length === 0 && report.verdict === 'fail') {
      console.error("[bastion] qa: the qa role's verdict is fail but it reported no finding; read .bastion/qa-report.json.");
      return 1;
    }
    if (findings.length === 0) {
      console.log(`[bastion] qa: pass (${runs.length} case(s) run).`);
      return 0;
    }
    return reportFailure(findings);
  };

  try {
    return await inWorktree();
  } finally {
    removeWt();
  }
}
