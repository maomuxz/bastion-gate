import * as fs from 'node:fs';
import * as path from 'node:path';
import { readConfigFromDisk, readLockFromDisk } from '../config.js';
import {
  GAPS_MD_REL_PATH,
  GAPS_REPORT_REL_PATH,
  buildCriticPrompt,
  checkQuotes,
  listTestCases,
  parseGapsReport,
  removeTestCase,
  renderGapsMarkdown,
} from '../gaps.js';
import type { Gap, TestSource } from '../gaps.js';
import { getRepoRoot } from '../git.js';
import { resolveAgentCommand, runRole } from '../roles.js';
import { matchesAnyGlob } from '../runner.js';

// The wall: kernel files must not import src/commands/stages.ts (it reaches add-on modules), so the option shape is local.
interface GapsOptions { cwd: string; timeoutMinutes?: number; probe?: boolean; drop?: string }

export interface ProbeResult {
  /** Test file and case name that was hidden from the critic. */
  file: string;
  name: string;
  /** True when the judge says one of the critic's gaps describes the hidden case. */
  detected: boolean;
}
export interface GapsResult {
  /** False when the check could not be completed (no requirement, no tests, role failure, invalid report). */
  ok: boolean;
  /** Reason when !ok. */
  error?: string;
  kept: Gap[];
  discarded: Gap[];
  probe?: ProbeResult;
}

/**
 * v1.1 gap check core, shared by `bastion gaps` and `bastion tests --lock`.
 *
 * Inputs: the requirement is .bastion/requirement.md (missing or blank -> !ok). The tests are `testFiles`
 * (repo-relative) when given. v1.1 kernel rule: otherwise they are the locked test files - every lockedFiles path of
 * .bastion/lock.json that matches one of config.lockedGlobs (so package.json and other extraLockedPaths are left out),
 * in lock order; no lock.json -> !ok with an error that says to pass through `bastion lock` first. .bastion/map.json is
 * never read (this file must not import src/map.ts - see src/wall.ts). Files that do not exist are skipped; no readable
 * test file -> !ok. The command is resolveAgentCommand(config, 'critic'); none -> !ok.
 *
 * Normal mode: call runRole(command, 'critic', { label: 'gaps', cwd: repoRoot, outputPath: <repo>/.bastion/gaps.json,
 * prompt: buildCriticPrompt(requirement, tests) }) after deleting any old report. Non-zero exit or a report that
 * parseGapsReport rejects -> !ok (fail closed; never treated as "no gaps"). Otherwise { ok: true, ...checkQuotes(...) }.
 * The prompt must contain nothing but the requirement and the tests (no interfaces, no map, no acceptance.md).
 *
 * Probe mode (`probe` set): proves the critic can see a hole. Pick the case to hide: `drop` is "<file>::<case name>"
 * (unknown file or case -> !ok); without `drop`, list all cases of all test files in order (listTestCases) and take the
 * one at index Math.floor(count / 2) (no case at all -> !ok). Hide it with removeTestCase in the prompt copy only - no
 * file on disk changes. Call the critic with label 'gaps-probe' and output <repo>/.bastion/gaps-probe.json. Then, if it
 * kept at least one gap, call the critic role once more with label 'gaps-probe-judge' and output
 * <repo>/.bastion/gaps-probe-judge.json; that prompt shows the removed test source and the numbered kept gaps and asks
 * for {"detected": true|false}. A judge failure or invalid JSON -> !ok. No kept gap -> detected false without a judge call.
 * Returns { ok: true, kept, discarded, probe: { file, name, detected } }.
 */
/*
 * v1.1 hardening (round 5), normal mode (not probe):
 * - when the critic reported at least one gap and checkQuotes discarded ALL of them, the check did not happen in any
 *   useful sense: findGaps returns { ok: false, error: `critic reported <n> gap(s) but none of them quotes the requirement; the gap check does not count.` }
 *   (callers already print the error and return 1; nothing gets locked);
 * - when only some were discarded, findGaps prints to stderr
 *   `[bastion] gaps: <n> reported gap(s) dropped because their quote is not in the requirement.` and goes on as before.
 * A report with zero gaps is still ok with kept [] and discarded [].
 */
export async function findGaps(
  repoRoot: string,
  opts: { timeoutMinutes?: number; probe?: boolean; drop?: string; testFiles?: string[] } = {}
): Promise<GapsResult> {
  const fail = (error: string): GapsResult => ({ ok: false, error, kept: [], discarded: [] });
  const reqPath = path.join(repoRoot, '.bastion', 'requirement.md');
  const requirement = fs.existsSync(reqPath) ? fs.readFileSync(reqPath, 'utf8') : '';
  if (requirement.trim() === '') return fail('.bastion/requirement.md is missing or blank.');

  let config;
  try {
    config = readConfigFromDisk(repoRoot);
  } catch (e) {
    return fail((e as Error).message);
  }
  const command = resolveAgentCommand(config, 'critic');
  if (!command) return fail('no critic command configured (roles.critic or agentCommand).');

  let files = opts.testFiles;
  if (!files) {
    try {
      files = readLockFromDisk(repoRoot).lockedFiles.map((f) => f.path);
    } catch (e) {
      return fail(`${(e as Error).message} (pass the tests through "bastion lock" first)`);
    }
    files = files.filter((f) => matchesAnyGlob(f, config.lockedGlobs));
  }
  const tests: TestSource[] = [];
  for (const file of new Set(files)) {
    const abs = path.join(repoRoot, file);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
    tests.push({ file, content: fs.readFileSync(abs, 'utf8') });
  }
  if (tests.length === 0) return fail('no readable test file found.');

  const timeoutMs = opts.timeoutMinutes && opts.timeoutMinutes > 0 ? opts.timeoutMinutes * 60_000 : undefined;
  const runCritic = async (
    label: string, rel: string, prompt: string
  ): Promise<{ ok: true; raw: unknown } | { ok: false; error: string }> => {
    const out = path.join(repoRoot, rel);
    fs.rmSync(out, { force: true });
    const res = await runRole(command, 'critic', { label, cwd: repoRoot, repoRoot, outputPath: out, prompt, timeoutMs });
    if (res.exitCode !== 0) return { ok: false, error: `critic (${label}) exited with ${res.exitCode}${res.timedOut ? ' (timed out)' : ''}.` };
    if (!fs.existsSync(out)) return { ok: false, error: `critic (${label}) wrote no report to ${rel}.` };
    try {
      return { ok: true, raw: JSON.parse(fs.readFileSync(out, 'utf8')) };
    } catch {
      return { ok: false, error: `critic (${label}) wrote invalid JSON to ${rel}.` };
    }
  };

  if (!opts.probe) {
    const r = await runCritic('gaps', GAPS_REPORT_REL_PATH, buildCriticPrompt(requirement, tests));
    if (!r.ok) return fail(r.error);
    const report = parseGapsReport(r.raw);
    if (!report) return fail('critic report is not a valid gaps report.');
    const split = checkQuotes(report, requirement);
    if (report.gaps.length > 0 && split.kept.length === 0) {
      return fail(`critic reported ${report.gaps.length} gap(s) but none of them quotes the requirement; the gap check does not count.`);
    }
    if (split.discarded.length > 0) {
      console.error(`[bastion] gaps: ${split.discarded.length} reported gap(s) dropped because their quote is not in the requirement.`);
    }
    return { ok: true, ...split };
  }

  // Probe mode: hide one case from the critic (prompt copy only).
  let file: string;
  let name: string;
  if (opts.drop !== undefined) {
    const sep = opts.drop.indexOf('::');
    if (sep < 0) return fail('--drop must look like "<file>::<case name>".');
    file = opts.drop.slice(0, sep);
    name = opts.drop.slice(sep + 2);
    const t = tests.find((x) => x.file === file);
    if (!t) return fail(`--drop: test file ${file} is not part of the suite.`);
    if (!listTestCases(t.content).includes(name)) return fail(`--drop: no test case "${name}" in ${file}.`);
  } else {
    const all: Array<{ file: string; name: string }> = [];
    for (const t of tests) for (const n of listTestCases(t.content)) all.push({ file: t.file, name: n });
    if (all.length === 0) return fail('probe: the test suite has no test case.');
    const pick = all[Math.floor(all.length / 2)]!;
    file = pick.file;
    name = pick.name;
  }
  const target = tests.find((x) => x.file === file)!;
  const removal = removeTestCase(target.content, name);
  if (!removal) return fail(`probe: could not remove test case "${name}" from ${file}.`);
  const hidden = tests.map((t) => (t === target ? { file: t.file, content: removal.source } : t));

  const r = await runCritic('gaps-probe', '.bastion/gaps-probe.json', buildCriticPrompt(requirement, hidden));
  if (!r.ok) return fail(r.error);
  const report = parseGapsReport(r.raw);
  if (!report) return fail('critic probe report is not a valid gaps report.');
  const split = checkQuotes(report, requirement);
  if (split.kept.length === 0) return { ok: true, ...split, probe: { file, name, detected: false } };

  const judgePrompt = [
    'A test case was removed from a test suite. A critic then listed requirement rules that no remaining test checks.',
    'Decide whether any of the numbered gaps below describes what the removed test case checked.',
    'Judge only from the text in this prompt and do not read any file.',
    'Write {"detected": true} or {"detected": false} as JSON to the BASTION_OUTPUT path.',
    '',
    `## Removed test case (${file})`,
    removal.removed,
    '',
    '## Gaps',
    ...split.kept.map((g, i) => `${i + 1}. ${g.rule}\n   > ${g.quote}`),
    '',
  ].join('\n');
  const j = await runCritic('gaps-probe-judge', '.bastion/gaps-probe-judge.json', judgePrompt);
  if (!j.ok) return fail(j.error);
  const verdict = j.raw as Record<string, unknown> | null;
  if (typeof verdict !== 'object' || verdict === null || typeof verdict.detected !== 'boolean') {
    return fail('probe judge report is invalid (expected {"detected": true|false}).');
  }
  return { ok: true, ...split, probe: { file, name, detected: verdict.detected } };
}

/**
 * `bastion gaps [--probe] [--drop "<file>::<case>"]`. Not in a git repo, unreadable config or !ok -> print the error
 * to stderr, return 1.
 * Normal mode: write .bastion/gaps.md (renderGapsMarkdown); print each kept gap as `[bastion] gaps: <rule>`; return 0
 * when there is no kept gap (print `[bastion] gaps: none found.`), 1 otherwise. Discarded gaps never fail the command.
 * Probe mode: does not write gaps.md. detected -> print `[bastion] gaps: probe detected the hidden case "<name>" (<file>).`
 * and return 0; otherwise print to stderr `[bastion] gaps: probe MISSED the hidden case "<name>" (<file>).` plus a line
 * saying the case may be redundant with another test, and return 1.
 */
export async function runGaps(opts: GapsOptions): Promise<number> {
  const repoRoot = getRepoRoot(opts.cwd);
  if (!repoRoot) {
    console.error('[bastion] Error: not inside a git repository.');
    return 1;
  }
  try {
    readConfigFromDisk(repoRoot);
  } catch (e) {
    console.error(`[bastion] Error: ${(e as Error).message}`);
    return 1;
  }
  const res = await findGaps(repoRoot, { timeoutMinutes: opts.timeoutMinutes, probe: opts.probe, drop: opts.drop });
  if (!res.ok) {
    console.error(`[bastion] gaps: ${res.error ?? 'gap check failed.'}`);
    return 1;
  }
  if (res.probe) {
    const { file, name, detected } = res.probe;
    if (detected) {
      console.log(`[bastion] gaps: probe detected the hidden case "${name}" (${file}).`);
      return 0;
    }
    console.error(`[bastion] gaps: probe MISSED the hidden case "${name}" (${file}).`);
    console.error('[bastion] gaps: the case may be redundant with another test; try --drop "<file>::<case>" with a different case.');
    return 1;
  }
  const mdPath = path.join(repoRoot, GAPS_MD_REL_PATH);
  fs.mkdirSync(path.dirname(mdPath), { recursive: true });
  const md = renderGapsMarkdown(res.kept, res.discarded);
  fs.writeFileSync(mdPath, md.endsWith('\n') ? md : md + '\n', 'utf8');
  if (res.kept.length === 0) {
    console.log('[bastion] gaps: none found.');
    return 0;
  }
  for (const g of res.kept) console.log(`[bastion] gaps: ${g.rule}`);
  return 1;
}
