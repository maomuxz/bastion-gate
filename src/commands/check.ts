import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  BareFinding,
  CheckConfig,
  CheckStepSpec,
  formatBareReport,
  loadCheckConfig,
  MAX_CHECK_RETRIES,
  parseBareFindings,
  validateMaxRetries,
  verifyCheckLocks,
  writeCheckLock,
} from '../check-core.js';
import { LOCK_REL_PATH, readConfigFromDisk } from '../config.js';
import { getRepoRoot, resolveRef, toPosixPath } from '../git.js';
import { resolveAgentCommand, runRole } from '../roles.js';
import { runTestCommandAsync } from '../runner.js';
import { checkGateIntegrity } from './gate.js';

export interface CheckCommandOptions {
  cwd: string;
  configPath?: string;
  baseRef?: string;
  lock?: boolean;
  files?: string[];
  agentCommand?: string;
  maxRetries?: number;
  json?: boolean;
}

export interface CheckRunSummary {
  ok: boolean;
  exitCode: number;
  roundsUsed: number;
  tampered: boolean;
  findings: BareFinding[];
  report: string;
}

function resolveTargetFilesRelToProject(cwd: string, projectRoot: string, rawFiles: string[]): string[] {
  return rawFiles.map((f) => {
    const abs = path.resolve(cwd, f);
    const rel = toPosixPath(path.relative(projectRoot, abs));
    return !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : toPosixPath(f);
  });
}

function expandStepCommand(step: CheckStepSpec, stepCwd: string, projectRoot: string, targetFilesRel: string[]): string {
  if (!step.command.includes('{files}')) return step.command;
  if (targetFilesRel.length === 0) {
    return step.command.replace(/\{files\}/g, '.');
  }
  const quoted = targetFilesRel.map((relProj) => {
    const abs = path.resolve(projectRoot, relProj);
    const relStep = toPosixPath(path.relative(stepCwd, abs));
    return relStep.includes(' ') ? `"${relStep}"` : relStep;
  });
  return step.command.replace(/\{files\}/g, quoted.join(' '));
}

async function runSingleCheckPass(
  projectRoot: string,
  checkLockPath: string,
  config: CheckConfig,
  targetFilesRel: string[],
  baseRef?: string
): Promise<{ ok: boolean; tampered: boolean; findings: BareFinding[]; report: string }> {
  // 1. Reuse bastion gate integrity check when inside a git repo that has a baseline `.bastion/lock.json`
  const repoRoot = getRepoRoot(projectRoot);
  if (repoRoot && repoRoot === projectRoot) {
    const candidateBase = baseRef ?? (fs.existsSync(path.join(projectRoot, '.bastion/config.json')) ? readConfigFromDisk(projectRoot).baseBranch : undefined);
    if (candidateBase && resolveRef(candidateBase, repoRoot) && fs.existsSync(path.join(projectRoot, LOCK_REL_PATH))) {
      try {
        const gateIntegrity = checkGateIntegrity({ cwd: projectRoot, baseRef: candidateBase });
        if (!gateIntegrity.ok) {
          return {
            ok: false,
            tampered: true,
            findings: [{ file: LOCK_REL_PATH, line: 1, rule: 'LOCK_INTEGRITY', message: '锁定范围被越权修改' }],
            report: gateIntegrity.feedback,
          };
        }
      } catch {
        // When `.bastion/lock.json` exists locally but wasn't committed on `candidateBase` yet, `verifyCheckLocks` below still checks its hashes.
      }
    }
  }

  // 2. Verify `.bastion/check-lock.json`, local `.bastion/lock.json` hashes, and `lockedFiles` git status
  const lockVerify = verifyCheckLocks(projectRoot, checkLockPath, config, baseRef);
  if (!lockVerify.ok) {
    const findings: BareFinding[] = lockVerify.violations.map((v) => ({
      file: v.split(':').pop()?.trim() || '.bastion/check-lock.json',
      line: 1,
      rule: 'LOCK_TAMPERED',
      message: v,
    }));
    const report = formatBareReport(findings);
    return { ok: false, tampered: true, findings, report };
  }

  const targetSet = new Set(targetFilesRel);
  const allFindings: BareFinding[] = [];
  const allSteps: Array<{ kind: 'compile' | 'rule'; step: CheckStepSpec }> = [
    ...config.compile.map((step) => ({ kind: 'compile' as const, step })),
    ...config.rules.map((step) => ({ kind: 'rule' as const, step })),
  ];

  for (const { kind, step } of allSteps) {
    const relStepCwd = step.cwd ?? config.cwd;
    const stepCwd = relStepCwd ? path.resolve(projectRoot, relStepCwd) : projectRoot;
    const cmd = expandStepCommand(step, stepCwd, projectRoot, targetFilesRel);
    const res = await runTestCommandAsync(cmd, stepCwd, config.timeoutMs);

    if (res.exitCode === 0) continue;

    const combined = `${res.stdout}\n${res.stderr}`;
    const parsed = parseBareFindings(combined, step.name, stepCwd, projectRoot);

    if (targetSet.size > 0 && parsed.length > 0) {
      const scoped = parsed.filter((f) => targetSet.has(f.file));
      if (scoped.length > 0) {
        allFindings.push(...scoped);
        continue;
      }
      // For compile checks, if exitCode != 0 and no finding matched targetSet (e.g. a downstream caller broke), keep parsed errors so compile breakage is never masked.
      // For global rule scripts that scan the whole repo, if explicit target files had 0 violations, ignore pre-existing unrelated files.
      if (kind === 'compile') {
        allFindings.push(...parsed);
      }
      continue;
    }

    if (parsed.length > 0) {
      allFindings.push(...parsed);
    } else {
      // Unstructured non-zero failure fallback (e.g. missing binary, syntax crash, timeout)
      const firstNonEmpty =
        combined
          .split(/\r?\n/)
          .map((l) => l.trim())
          .find((l) => l.length > 0) ?? `${step.name} exited with code ${res.exitCode}`;
      allFindings.push({
        file: targetFilesRel[0] ?? (relStepCwd ?? '.'),
        line: 1,
        rule: step.name,
        message: firstNonEmpty.slice(0, 200),
      });
    }
  }

  const ok = allFindings.length === 0;
  return {
    ok,
    tampered: false,
    findings: allFindings,
    report: formatBareReport(allFindings),
  };
}

export async function executeCheck(opts: CheckCommandOptions): Promise<CheckRunSummary> {
  const { projectRoot, configRelOrAbs, checkLockPath, config } = loadCheckConfig(opts.cwd, opts.configPath);
  const maxRetries =
    opts.maxRetries !== undefined
      ? validateMaxRetries(opts.maxRetries, '--max-retries')
      : config.maxRetries;

  if (opts.lock) {
    const written = writeCheckLock(projectRoot, configRelOrAbs, checkLockPath, config.lockedFiles);
    const relLock = toPosixPath(path.relative(projectRoot, checkLockPath)) || path.basename(checkLockPath);
    if (!opts.json) {
      console.log(`[bastion] check: locked ${written.files.length} file(s) in ${relLock}.`);
    } else {
      console.log(JSON.stringify({ ok: true, lockedFiles: written.files }, null, 2));
    }
    return { ok: true, exitCode: 0, roundsUsed: 0, tampered: false, findings: [], report: '' };
  }

  const targetFilesRel = resolveTargetFilesRelToProject(opts.cwd, projectRoot, opts.files ?? []);
  for (const rel of targetFilesRel) {
    if (!fs.existsSync(path.resolve(projectRoot, rel))) {
      throw new Error(`Target file does not exist: ${rel}`);
    }
  }

  // Resolve optional rework agent command (only runs rework loop when `--agent` is explicitly supplied)
  let agentCmd: string | undefined;
  if (opts.agentCommand !== undefined) {
    if (!opts.agentCommand.trim()) {
      throw new Error('Invalid --agent: command string must not be empty.');
    }
    agentCmd = resolveAgentCommand(
      fs.existsSync(path.join(projectRoot, '.bastion/config.json')) ? readConfigFromDisk(projectRoot) : {
        version: 1,
        testCommand: 'true',
        baseBranch: 'main',
        lockedGlobs: [],
        extraLockedPaths: [],
      },
      'worker',
      opts.agentCommand.trim()
    );
  }

  let current = await runSingleCheckPass(projectRoot, checkLockPath, config, targetFilesRel, opts.baseRef);
  let roundsUsed = 0;

  // Bounded rework loop: at most `maxRetries` (<= MAX_CHECK_RETRIES = 2) rounds; never retry on lock tampering!
  while (!current.ok && !current.tampered && agentCmd && roundsUsed < maxRetries) {
    roundsUsed++;
    const reportDir = path.join(projectRoot, '.bastion', 'logs');
    fs.mkdirSync(reportDir, { recursive: true });
    const reportFile = path.join(reportDir, `check-round-${roundsUsed}-report.txt`);
    fs.writeFileSync(reportFile, current.report + '\n', 'utf8');

    const prompt = [
      `[Bastion Check Failed - Rework Round ${roundsUsed}/${maxRetries}]`,
      'The following compile or locked-rule violations were found (file:line [rule]):',
      current.report,
      '',
      targetFilesRel.length > 0 ? `Target file(s): ${targetFilesRel.join(', ')}` : '',
      'Fix the violations above while keeping all required functionality intact. Do not modify locked check scripts or configs.',
    ]
      .filter(Boolean)
      .join('\n');

    const prevEnvReport = process.env.BASTION_CHECK_REPORT_FILE;
    process.env.BASTION_CHECK_REPORT_FILE = reportFile;
    try {
      await runRole(agentCmd, 'worker', {
        prompt,
        cwd: projectRoot,
        repoRoot: projectRoot,
        label: `check-rework-${roundsUsed}`,
        timeoutMs: config.timeoutMs,
        attempt: roundsUsed,
      });
    } finally {
      if (prevEnvReport === undefined) delete process.env.BASTION_CHECK_REPORT_FILE;
      else process.env.BASTION_CHECK_REPORT_FILE = prevEnvReport;
    }

    current = await runSingleCheckPass(projectRoot, checkLockPath, config, targetFilesRel, opts.baseRef);
  }

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          ok: current.ok,
          roundsUsed,
          tampered: current.tampered,
          findings: current.findings,
          report: current.report,
        },
        null,
        2
      )
    );
  } else if (current.ok) {
    const suffix = roundsUsed > 0 ? ` (after ${roundsUsed} rework round(s))` : '';
    console.log(`[bastion] CHECK PASS: compile and locked rules passed${suffix}.`);
  } else {
    const reason = current.tampered ? 'locked file integrity violation' : `${current.findings.length} violation(s)`;
    console.error(`[bastion] CHECK FAIL (${reason}, rework rounds used: ${roundsUsed}/${agentCmd ? maxRetries : 0}):`);
    console.error(current.report);
  }

  return {
    ok: current.ok,
    exitCode: current.ok ? 0 : 1,
    roundsUsed,
    tampered: current.tampered,
    findings: current.findings,
    report: current.report,
  };
}

export async function runCheck(opts: CheckCommandOptions): Promise<number> {
  const res = await executeCheck(opts);
  return res.exitCode;
}
