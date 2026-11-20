import * as fs from 'node:fs';
import * as path from 'node:path';
import { BASTION_DIR, CONFIG_REL_PATH, LOCK_REL_PATH, readConfigFromDisk, readLockFromDisk } from './config.js';
import { getChangedFilesBetween, getDirtyFiles, getRepoRoot, resolveRef, toPosixPath } from './git.js';
import { contentHash, hashMatches, matchesAnyGlob, walkRepoFiles } from './runner.js';

export const CHECK_CONFIG_REL_PATH = '.bastion/check.json';
export const CHECK_LOCK_REL_PATH = '.bastion/check-lock.json';
export const MAX_CHECK_RETRIES = 2;

export interface CheckStepSpec {
  /** Short rule/check label used when a line has no explicit `[CODE]` tag. */
  name: string;
  /** Shell command to execute; may use `{files}` placeholder for target files. */
  command: string;
  /** Optional working directory relative to `projectRoot`. */
  cwd?: string;
}

export interface CheckConfig {
  /** Default working directory relative to `projectRoot` for commands without their own `cwd`. */
  cwd?: string;
  /** Project compile check command(s). */
  compile: CheckStepSpec[];
  /** Project locked hard-rule check command(s). */
  rules: CheckStepSpec[];
  /** Glob patterns or relative file paths of rule scripts / analyzer configs that must not be modified. */
  lockedFiles: string[];
  /** Max rework rounds when `--agent` is used (0..2, default 2). */
  maxRetries: number;
  /** Per-command timeout in milliseconds (optional). */
  timeoutMs?: number;
}

export interface CheckLockFile {
  version: 1;
  lockedAt: string;
  files: Array<{
    path: string;
    sha256: string;
  }>;
}

export interface BareFinding {
  file: string;
  line: number;
  rule: string;
  message: string;
}

function stripBom(raw: string): string {
  return raw.replace(/^\uFEFF/, '');
}

function normalizeStepList(
  raw: unknown,
  defaultNamePrefix: string,
  label: string,
  allowEmpty: boolean
): CheckStepSpec[] {
  if (raw === undefined || raw === null) {
    if (allowEmpty) return [];
    throw new Error(`Invalid ${label}: missing required "${defaultNamePrefix}" command configuration.`);
  }
  const arr = Array.isArray(raw) ? raw : [raw];
  if (!allowEmpty && arr.length === 0) {
    throw new Error(`Invalid ${label}: "${defaultNamePrefix}" must contain at least one command.`);
  }

  return arr.map((item, idx) => {
    const fallbackName = arr.length === 1 ? defaultNamePrefix : `${defaultNamePrefix}-${idx + 1}`;
    if (typeof item === 'string') {
      if (!item.trim()) throw new Error(`Invalid ${label}: ${defaultNamePrefix}[${idx}] must be a non-empty command string.`);
      return { name: fallbackName, command: item.trim() };
    }
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`Invalid ${label}: ${defaultNamePrefix}[${idx}] must be a string or { name?, command, cwd? } object.`);
    }
    const obj = item as Record<string, unknown>;
    if (typeof obj.command !== 'string' || !obj.command.trim()) {
      throw new Error(`Invalid ${label}: ${defaultNamePrefix}[${idx}].command must be a non-empty string.`);
    }
    return {
      name: typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : fallbackName,
      command: obj.command.trim(),
      ...(typeof obj.cwd === 'string' && obj.cwd.trim() ? { cwd: toPosixPath(obj.cwd.trim()) } : {}),
    };
  });
}

export function validateMaxRetries(val: unknown, label: string): number {
  if (val === undefined) return MAX_CHECK_RETRIES;
  const num = typeof val === 'number' ? val : Number(val);
  if (!Number.isInteger(num) || num < 0 || num > MAX_CHECK_RETRIES) {
    throw new Error(
      `Invalid ${label}: maxRetries must be an integer between 0 and ${MAX_CHECK_RETRIES} (got ${JSON.stringify(val)}).`
    );
  }
  return num;
}

/** Parse and validate `.bastion/check.json` (or `--config`). */
export function parseCheckConfig(raw: string, label: string, fallbackRuleChecks: string[] = []): CheckConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripBom(raw));
  } catch (err) {
    throw new Error(`Invalid JSON in ${label}: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid ${label}: config root must be a JSON object.`);
  }
  const obj = parsed as Record<string, unknown>;
  const compile = normalizeStepList(obj.compile, 'compile', label, false);
  const rulesRaw = obj.rules !== undefined ? obj.rules : fallbackRuleChecks;
  const rules = normalizeStepList(rulesRaw, 'rule', label, true);

  let lockedFiles: string[] = [];
  if (obj.lockedFiles !== undefined) {
    if (!Array.isArray(obj.lockedFiles) || obj.lockedFiles.some((x) => typeof x !== 'string' || !x.trim())) {
      throw new Error(`Invalid ${label}: "lockedFiles" must be an array of non-empty file/glob strings.`);
    }
    lockedFiles = obj.lockedFiles.map((x: string) => toPosixPath(x.trim()));
  }

  const maxRetries = validateMaxRetries(obj.maxRetries, `${label}.maxRetries`);
  let timeoutMs: number | undefined;
  if (obj.timeoutSeconds !== undefined) {
    const secs = Number(obj.timeoutSeconds);
    if (!Number.isFinite(secs) || secs <= 0) {
      throw new Error(`Invalid ${label}: "timeoutSeconds" must be a positive number.`);
    }
    timeoutMs = Math.round(secs * 1000);
  }

  return {
    ...(typeof obj.cwd === 'string' && obj.cwd.trim() ? { cwd: toPosixPath(obj.cwd.trim()) } : {}),
    compile,
    rules,
    lockedFiles,
    maxRetries,
    ...(timeoutMs ? { timeoutMs } : {}),
  };
}

/** Load `CheckConfig` from explicit `--config`, `.bastion/check.json`, or `check` inside `.bastion/config.json`. */
export function loadCheckConfig(cwd: string, explicitConfigPath?: string): {
  projectRoot: string;
  configRelOrAbs: string;
  checkLockPath: string;
  config: CheckConfig;
} {
  if (explicitConfigPath) {
    const absCfg = path.resolve(cwd, explicitConfigPath);
    if (!fs.existsSync(absCfg)) {
      throw new Error(`Check config file not found: ${explicitConfigPath}`);
    }
    const cfgDir = path.dirname(absCfg);
    const projectRoot =
      path.basename(cfgDir) === BASTION_DIR
        ? path.dirname(cfgDir)
        : (getRepoRoot(cwd) ?? cwd);
    let fallbackChecks: string[] = [];
    if (fs.existsSync(path.join(projectRoot, CONFIG_REL_PATH))) {
      try {
        fallbackChecks = readConfigFromDisk(projectRoot).checks ?? [];
      } catch {
        // ignore unrelated main config issues when explicit --config is given
      }
    }
    const config = parseCheckConfig(fs.readFileSync(absCfg, 'utf8'), explicitConfigPath, fallbackChecks);
    const lockPath =
      path.basename(cfgDir) === BASTION_DIR
        ? path.join(projectRoot, CHECK_LOCK_REL_PATH)
        : `${absCfg}.lock.json`;
    return { projectRoot, configRelOrAbs: absCfg, checkLockPath: lockPath, config };
  }

  const projectRoot = getRepoRoot(cwd) ?? cwd;
  let fallbackChecks: string[] = [];
  let embeddedCheck: unknown;
  const mainCfgPath = path.join(projectRoot, CONFIG_REL_PATH);
  if (fs.existsSync(mainCfgPath)) {
    const rawMain = stripBom(fs.readFileSync(mainCfgPath, 'utf8'));
    let mainObj: Record<string, unknown>;
    try {
      mainObj = JSON.parse(rawMain) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`Invalid JSON in ${CONFIG_REL_PATH}: ${(err as Error).message}`);
    }
    if (Array.isArray(mainObj.checks)) {
      fallbackChecks = mainObj.checks.filter((c): c is string => typeof c === 'string' && c.trim() !== '');
    }
    embeddedCheck = mainObj.check;
  }

  const checkCfgPath = path.join(projectRoot, CHECK_CONFIG_REL_PATH);
  if (fs.existsSync(checkCfgPath)) {
    return {
      projectRoot,
      configRelOrAbs: CHECK_CONFIG_REL_PATH,
      checkLockPath: path.join(projectRoot, CHECK_LOCK_REL_PATH),
      config: parseCheckConfig(fs.readFileSync(checkCfgPath, 'utf8'), CHECK_CONFIG_REL_PATH, fallbackChecks),
    };
  }

  if (embeddedCheck !== undefined) {
    return {
      projectRoot,
      configRelOrAbs: CONFIG_REL_PATH,
      checkLockPath: path.join(projectRoot, CHECK_LOCK_REL_PATH),
      config: parseCheckConfig(JSON.stringify(embeddedCheck), `${CONFIG_REL_PATH}#check`, fallbackChecks),
    };
  }

  throw new Error(
    `Missing ${CHECK_CONFIG_REL_PATH}. Create ${CHECK_CONFIG_REL_PATH} (or pass --config <path>) to configure "bastion check".`
  );
}

/** Resolve all concrete relative paths matched by `config.lockedFiles` (plus the check config file if inside projectRoot). */
export function resolveCheckLockedPaths(projectRoot: string, configRelOrAbs: string, patterns: string[]): string[] {
  const matched = new Set<string>();
  const allFiles = walkRepoFiles(projectRoot);

  const globPatterns: string[] = [];
  for (const p of patterns) {
    if (/[*?]/.test(p)) {
      globPatterns.push(p);
    } else {
      const abs = path.resolve(projectRoot, p);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        throw new Error(`Locked rule/config file does not exist: ${p}`);
      }
      matched.add(toPosixPath(path.relative(projectRoot, abs)));
    }
  }

  if (globPatterns.length > 0) {
    for (const rel of allFiles) {
      if (matchesAnyGlob(rel, globPatterns)) matched.add(rel);
    }
  }

  const absCfg = path.resolve(projectRoot, configRelOrAbs);
  const relCfg = toPosixPath(path.relative(projectRoot, absCfg));
  if (!relCfg.startsWith('..') && !path.isAbsolute(relCfg) && fs.existsSync(absCfg)) {
    matched.add(relCfg);
  }

  return [...matched].sort();
}

/** Write `.bastion/check-lock.json` recording line-ending-independent SHA-256 hashes of locked rule scripts & config. */
export function writeCheckLock(projectRoot: string, configRelOrAbs: string, checkLockPath: string, patterns: string[]): CheckLockFile {
  const relPaths = resolveCheckLockedPaths(projectRoot, configRelOrAbs, patterns);
  const files = relPaths.map((rel) => ({
    path: rel,
    sha256: contentHash(fs.readFileSync(path.resolve(projectRoot, rel))),
  }));
  const lock: CheckLockFile = {
    version: 1,
    lockedAt: new Date().toISOString(),
    files,
  };
  fs.mkdirSync(path.dirname(checkLockPath), { recursive: true });
  fs.writeFileSync(checkLockPath, JSON.stringify(lock, null, 2) + '\n', 'utf8');
  return lock;
}

/**
 * Verify locked files have not been tampered with, reusing `.bastion/lock.json` (when present)
 * and `.bastion/check-lock.json` / git history on `lockedFiles`.
 */
export function verifyCheckLocks(
  projectRoot: string,
  checkLockPath: string,
  config: CheckConfig,
  baseRef?: string
): { ok: true } | { ok: false; violations: string[] } {
  const violations: string[] = [];

  // 1. Verify `.bastion/lock.json` on disk if present (reusing readLockFromDisk + hashMatches)
  const mainLockPath = path.join(projectRoot, LOCK_REL_PATH);
  if (fs.existsSync(mainLockPath)) {
    try {
      const mainLock = readLockFromDisk(projectRoot);
      for (const entry of mainLock.lockedFiles) {
        const abs = path.join(projectRoot, entry.path);
        if (!fs.existsSync(abs)) {
          violations.push(`Locked file missing: ${entry.path}`);
        } else if (!hashMatches(fs.readFileSync(abs), entry.sha256)) {
          violations.push(`Locked file modified: ${entry.path}`);
        }
      }
    } catch (err) {
      violations.push(`Corrupted ${LOCK_REL_PATH}: ${(err as Error).message}`);
    }
  }

  // 2. Verify `.bastion/check-lock.json` if present
  if (fs.existsSync(checkLockPath)) {
    try {
      const raw = JSON.parse(stripBom(fs.readFileSync(checkLockPath, 'utf8'))) as Partial<CheckLockFile>;
      if (!raw || !Array.isArray(raw.files)) {
        violations.push(`Invalid check lock file: ${toPosixPath(path.relative(projectRoot, checkLockPath))}`);
      } else {
        for (const entry of raw.files) {
          const abs = path.resolve(projectRoot, entry.path);
          if (!fs.existsSync(abs)) {
            violations.push(`Locked rule/config file deleted: ${entry.path}`);
          } else if (!hashMatches(fs.readFileSync(abs), entry.sha256)) {
            violations.push(`Locked rule/config file modified: ${entry.path}`);
          }
        }
      }
    } catch (err) {
      violations.push(`Cannot read check lock: ${(err as Error).message}`);
    }
  } else if (config.lockedFiles.length > 0 && getRepoRoot(projectRoot) === projectRoot) {
    // 3. Even before `bastion check --lock`, protect `lockedFiles` against uncommitted or branch edits in git
    const dirty = getDirtyFiles(projectRoot);
    const ref = baseRef ?? 'HEAD';
    const resolved = resolveRef(ref, projectRoot);
    const committed = resolved && resolved !== resolveRef('HEAD', projectRoot)
      ? getChangedFilesBetween(resolved, 'HEAD', projectRoot)
      : [];
    for (const rel of new Set([...dirty, ...committed])) {
      if (matchesAnyGlob(rel, config.lockedFiles) || config.lockedFiles.includes(rel)) {
        violations.push(`Locked rule/config file modified without authorization: ${rel}`);
      }
    }
  }

  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}

/**
 * Strip fix hints / remediation advice from a compiler or rule-check message so only
 * "what failed / which rule was violated" remains.
 */
export function stripFixHints(rawMessage: string): string {
  let msg = rawMessage.replace(/\s+/g, ' ').trim();

  // 1. Strip English compiler/linter fix suggestions (". Try ...", "; try ...", ". Did you mean ...", ". Use ... instead")
  msg = msg.replace(/\.\s+(?:Try|Did you mean|Use|Replace with|Consider)\b[\s\S]*$/i, '.');
  msg = msg.replace(/;\s*(?:try|did you mean|use|replace with)\b[\s\S]*$/i, '');

  // 2. Strip Chinese remediation clauses after punctuation ("，请用...", "；请改用...", "，应改用...", "；若需...请改为...")
  msg = msg.replace(
    /[，,；;。—\-]+\s*(?:若[^，,；;。]*?请|请(?:改用|使用|用|改为|将|在|把|删除|移除|通过|参考|先)|应(?:改用|使用|改为|通过)|建议(?:改用|使用|改为)|改用|换成)[\s\S]*$/,
    ''
  );

  // 3. Strip parenthetical fix hints containing "请用/改用/Try/Use" e.g. "（请用 Foo）"
  msg = msg.replace(/[（(][^）)]*(?:请(?:改用|使用|用|改为)|改用|\bTry\b|\bUse\b)[^）)]*[）)]/gi, '');

  // 4. Handle compact Chinese rule strings shaped as "<控件>请用 <Replacement>" with no comma before "请用"
  const mCompact = /^(.+?)\s*请(?:改用|使用|用|改为)\s+.+$/.exec(msg);
  if (mCompact && mCompact[1]!.trim()) {
    msg = `禁止直接使用该${mCompact[1]!.trim()}（违反统一组件约束）`;
  } else if (/^(?:请(?:改用|使用|用|改为|将|在|把|删除|移除)|\bTry\b|\bUse\b)/i.test(msg)) {
    msg = '违反该项锁定规则';
  }

  return msg.trim() || '违反该项锁定规则';
}

function normalizeFindingPath(rawFile: string, stepCwd: string, projectRoot: string): string {
  const cleaned = rawFile.trim().replace(/^['"]|['"]$/g, '');
  const abs = path.isAbsolute(cleaned) ? path.normalize(cleaned) : path.resolve(stepCwd, cleaned);
  const rel = toPosixPath(path.relative(projectRoot, abs));
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  return toPosixPath(cleaned);
}

/**
 * Parse raw stdout+stderr of a compile or rule command into structured bare findings (`file`, `line`, `rule`, `message`),
 * stripping all fix suggestions.
 */
export function parseBareFindings(
  rawOutput: string,
  fallbackRuleName: string,
  stepCwd: string,
  projectRoot: string
): BareFinding[] {
  const findings: BareFinding[] = [];
  const seen = new Set<string>();
  const lines = rawOutput.replace(/\r\n/g, '\n').split('\n');

  const addFinding = (file: string, line: number, rule: string, rawMsg: string): void => {
    const normFile = normalizeFindingPath(file, stepCwd, projectRoot);
    const safeLine = Number.isFinite(line) && line > 0 ? Math.floor(line) : 1;
    const cleanRule = rule.trim() || fallbackRuleName;
    const bareMsg = stripFixHints(rawMsg);
    const key = `${normFile}:${safeLine}:${cleanRule}:${bareMsg}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ file: normFile, line: safeLine, rule: cleanRule, message: bareMsg });
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // 1. Dart `dart analyze --format=machine`: SEVERITY|TYPE|CODE|FILE|LINE|COL|LEN|MESSAGE
    if (line.includes('|')) {
      const parts = line.split('|');
      if (parts.length >= 8 && /^(?:ERROR|WARNING|INFO)$/.test(parts[0]!)) {
        if (parts[0] !== 'ERROR') continue; // gate only on compile errors
        addFinding(parts[3]!, Number(parts[4]), parts[2]!, parts.slice(7).join('|'));
        continue;
      }
    }

    // 2. Dart `dart analyze` human format: `error • Message • path/to/file.dart:42:10 • error_code`
    const mDartHuman = /^(error|warning|info)\s+[•-]\s+(.+?)\s+[•-]\s+(.+?):(\d+):\d+\s+[•-]\s+([a-z0-9_]+)$/i.exec(line);
    if (mDartHuman) {
      if (mDartHuman[1]!.toLowerCase() !== 'error') continue;
      addFinding(mDartHuman[3]!, Number(mDartHuman[4]), mDartHuman[5]!.toUpperCase(), mDartHuman[2]!);
      continue;
    }

    // 3. TypeScript `tsc`: `src/foo.ts(12,5): error TS2322: Type ...`
    const mTsc = /^(.+?)\((\d+),\d+\):\s*error\s+(TS\d+):\s*(.+)$/.exec(line);
    if (mTsc) {
      addFinding(mTsc[1]!, Number(mTsc[2]), mTsc[3]!, mTsc[4]!);
      continue;
    }

    // 4. Explicit rule bracket format: `path/file.dart:123[:4] ... [R02]：message` or `path:12 [RULE] message`
    const mRuleBracket = /^([A-Za-z0-9_./\\-]+?\.[A-Za-z0-9_]+):(\d+)(?::\d+)?\s*(?:[•\-:]\s*)?(?:违反(?:规则)?\s*)?\[([^\]]+)\]\s*[：:—\-]?\s*(.*)$/.exec(line);
    if (mRuleBracket) {
      addFinding(mRuleBracket[1]!, Number(mRuleBracket[2]), mRuleBracket[3]!, mRuleBracket[4] || '违反该项锁定规则');
      continue;
    }

    // 5. Generic `path/to/file.ext:line[:col]  message` (e.g. `check_rules.dart`, eslint, grep-based checks)
    const mGeneric = /^([A-Za-z0-9_./\\-]+?\.[A-Za-z0-9_]+):(\d+)(?::\d+)?(?:\s+[•\-:]\s*|\s{1,})(.+)$/.exec(line);
    if (mGeneric) {
      addFinding(mGeneric[1]!, Number(mGeneric[2]), fallbackRuleName, mGeneric[3]!);
      continue;
    }
  }

  return findings;
}

/** Format bare findings into a deterministic, plain-text report without fix hints. */
export function formatBareReport(findings: BareFinding[]): string {
  return findings.map((f) => `- ${f.file}:${f.line} [${f.rule}] ${f.message}`).join('\n');
}
