import * as fs from 'node:fs';
import * as path from 'node:path';
import { readConfigFromDisk } from '../config.js';
import { execGit, getRepoRoot } from '../git.js';
import { resolveAgentCommand, runRole } from '../roles.js';
import { readRunState, writeRunState } from '../state.js';
import { QA_DISPUTES_REL_PATH, QA_REPORT_REL_PATH } from './stages.js';
import type { QaFinding, QaOptions, QaReport } from './stages.js';

const MAX_DIFF_CHARS = 200 * 1024;

/** P7: validate an untrusted QA report; null when invalid (verdict must be pass|fail, findings an array of {node, kind, issue}). */
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
  return { verdict: r.verdict, findings };
}

/**
 * P7 `bastion qa`: needs run-state (integration branch) and acceptance.md. Calls the qa role with acceptance.md and
 * `git diff <baseRef>...<integrationBranch>` (cut to 200 KB); the role writes a QaReport to BASTION_OUTPUT (.bastion/qa.json).
 * Invalid report -> 1. pass -> 0. fail -> for each 'code' finding: remove the node from run-state completedNodes and append the
 * issue to .bastion/feedback/<node>.md (bastion run --resume feeds it to the agent); 'test_defect' findings are listed in
 * .bastion/qa-disputes.md for a human (lock --amend). Returns 1 and prints what to do next.
 */
export async function runQa(opts: QaOptions): Promise<number> {
  const repoRoot = getRepoRoot(opts.cwd);
  if (!repoRoot) {
    console.error('[bastion] Error: not inside a git repository.');
    return 1;
  }
  const state = readRunState(repoRoot);
  if (!state) {
    console.error('[bastion] qa: no run-state found. Run "bastion run" first.');
    return 1;
  }
  const acceptancePath = path.join(repoRoot, '.bastion', 'acceptance.md');
  if (!fs.existsSync(acceptancePath)) {
    console.error('[bastion] qa: .bastion/acceptance.md is missing.');
    return 1;
  }
  const acceptance = fs.readFileSync(acceptancePath, 'utf8');
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
  const diffRes = execGit(['diff', `${state.baseRef}...${state.integrationBranch}`], repoRoot);
  if (!diffRes.ok) {
    console.error(`[bastion] qa: git diff failed: ${diffRes.stderr}`);
    return 1;
  }
  const diff = diffRes.stdout.length > MAX_DIFF_CHARS
    ? diffRes.stdout.slice(0, MAX_DIFF_CHARS) + '\n[... diff truncated at 200 KB ...]\n'
    : diffRes.stdout;

  const prompt = [
    'You are the QA reviewer. Check whether the integrated code satisfies every acceptance item.',
    `Write a JSON report to ${QA_REPORT_REL_PATH} (the BASTION_OUTPUT path) of the form:`,
    '{"verdict":"pass"|"fail","findings":[{"node":"<node id>","kind":"code"|"test_defect","issue":"<what is wrong>"}]}',
    'Use kind "code" when the implementation is wrong, "test_defect" when the locked test itself is wrong.',
    'A pass verdict must have an empty findings array.',
    '',
    '## Acceptance (acceptance.md)',
    acceptance,
    '',
    `## Integration diff (${state.baseRef}...${state.integrationBranch})`,
    diff,
    '',
  ].join('\n');

  const reportPath = path.join(repoRoot, QA_REPORT_REL_PATH);
  fs.rmSync(reportPath, { force: true });
  const timeoutMs = opts.timeoutMinutes && opts.timeoutMinutes > 0 ? opts.timeoutMinutes * 60_000 : undefined;
  const res = await runRole(command, 'qa', {
    prompt,
    cwd: repoRoot,
    repoRoot,
    label: 'qa',
    outputPath: reportPath,
    timeoutMs,
  });
  if (res.exitCode !== 0) {
    console.error(`[bastion] qa: qa role ${res.timedOut ? 'timed out' : `exited ${res.exitCode}`}.`);
    return 1;
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
  if (report.verdict === 'pass') {
    console.log('[bastion] qa: pass.');
    return 0;
  }

  const code = report.findings.filter((f) => f.kind === 'code');
  const defects = report.findings.filter((f) => f.kind === 'test_defect');
  if (code.length > 0) {
    const reopened = new Set(code.map((f) => f.node));
    writeRunState(repoRoot, { ...state, completedNodes: state.completedNodes.filter((n) => !reopened.has(n)) });
    const dir = path.join(repoRoot, '.bastion', 'feedback');
    fs.mkdirSync(dir, { recursive: true });
    for (const f of code) {
      const file = path.join(dir, `${path.basename(f.node)}.md`);
      const prev = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      const sep = prev && !prev.endsWith('\n') ? '\n' : '';
      fs.writeFileSync(file, `${prev}${sep}- ${f.issue}\n`, 'utf8');
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
    console.error(`[bastion] qa: reopened ${[...new Set(code.map((f) => f.node))].join(', ')}. Next: bastion run --resume`);
  }
  if (defects.length > 0) {
    console.error(`[bastion] qa: test defects listed in ${QA_DISPUTES_REL_PATH}. Next: review them, then bastion lock --amend.`);
  }
  return 1;
}
