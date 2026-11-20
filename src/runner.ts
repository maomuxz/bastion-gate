import { spawn, spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execGit, toPosixPath } from './git.js';

export interface CommandRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** v1.1: true only when the command was stopped because it ran longer than the given timeout. */
  timedOut?: boolean;
}

/** Node watchdog: runs the command, relays output as JSON, kills the whole process tree on timeout. */
const WATCHDOG_SCRIPT = `
const { spawn, spawnSync } = require('node:child_process');
const win = process.platform === 'win32';
const child = spawn(process.env.BASTION_WD_CMD, { shell: true, detached: !win, stdio: ['ignore', 'pipe', 'pipe'] });
const out = [], err = [];
let timedOut = false, done = false;
child.stdout.on('data', (d) => out.push(d));
child.stderr.on('data', (d) => err.push(d));
function finish(code) {
  if (done) return;
  done = true;
  process.stdout.write(JSON.stringify({
    code, timedOut,
    stdout: Buffer.concat(out).toString('utf8'),
    stderr: Buffer.concat(err).toString('utf8'),
  }), () => process.exit(0));
}
const timer = setTimeout(() => {
  timedOut = true;
  try {
    if (win) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-child.pid, 'SIGKILL');
  } catch {}
  try { child.kill('SIGKILL'); } catch {}
  setTimeout(() => finish(124), 300);
}, Number(process.env.BASTION_WD_MS));
child.on('error', () => { clearTimeout(timer); finish(1); });
child.on('close', (code) => { clearTimeout(timer); finish(code == null ? 1 : code); });
`;

/**
 * Run a test command in the repo root and capture its real exit code (synchronous).
 *
 * v1.1 timeout: when `timeoutMs` is a positive number and the command is still running after that many milliseconds,
 * the command AND every process it started are terminated (Windows: `taskkill /T /F` on the process tree; elsewhere:
 * the whole process group) so that nothing keeps running in the background, and the result is exitCode 124,
 * timedOut true, stderr ending with `[bastion] Command timed out after <timeoutMs>ms.` (output captured before the
 * timeout is kept). The call returns within a few seconds after the timeout. A command that finishes in time gives
 * exactly what it gives without a timeout (same exit code, stdout, stderr) and `timedOut` is not true.
 * Without timeoutMs (undefined, 0 or negative) behaviour is unchanged: wait for as long as it takes.
 * Implementation hint: this function must stay synchronous; a tree kill needs the root process alive, so one way is
 * to spawnSync a small node watchdog (`process.execPath -e <script>`) that starts the command asynchronously, relays
 * its output and exit code, and kills the tree on timeout.
 */
export function runTestCommand(command: string, cwd: string, timeoutMs?: number): CommandRunResult {
  const start = Date.now();
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  if (timeoutMs && timeoutMs > 0) {
    const wd = spawnSync(process.execPath, ['-e', WATCHDOG_SCRIPT], {
      cwd,
      env: { ...env, BASTION_WD_CMD: command, BASTION_WD_MS: String(timeoutMs) },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 1024 * 1024 * 1024,
      timeout: timeoutMs + 30_000, // backstop only; the watchdog enforces the real limit
    });
    try {
      const o = JSON.parse(wd.stdout ?? '') as { code: number; stdout: string; stderr: string; timedOut: boolean };
      let stderr = o.stderr;
      if (o.timedOut) stderr += `\n[bastion] Command timed out after ${timeoutMs}ms.`;
      return {
        exitCode: o.timedOut ? 124 : o.code,
        stdout: o.stdout,
        stderr,
        durationMs: Date.now() - start,
        ...(o.timedOut ? { timedOut: true } : {}),
      };
    } catch {
      return {
        exitCode: 124,
        stdout: '',
        stderr: `${wd.stderr ?? ''}\n[bastion] Command timed out after ${timeoutMs}ms.`,
        durationMs: Date.now() - start,
        timedOut: true,
      };
    }
  }
  const res = spawnSync(command, {
    cwd,
    env,
    shell: true,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    exitCode: res.status ?? 1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    durationMs: Date.now() - start,
  };
}

/**
 * v1.1 hardening (round 5): terminate a process and everything it started. Windows: `taskkill /PID <pid> /T /F`
 * (synchronous, errors ignored). Elsewhere: SIGKILL to the process group `-pid` (the process must have been started
 * with `detached: true`), falling back to the single pid. Never throws, also for a pid that no longer exists.
 */
export function killProcessTree(pid: number): void {
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
      return;
    }
    try {
      process.kill(-pid, 'SIGKILL');
      return;
    } catch {
      // fall through to the single pid
    }
    process.kill(pid, 'SIGKILL');
  } catch {
    // already gone
  }
}

/*
 * v1.1 hardening (round 5) of runTestCommandAsync: on timeout the whole process tree is terminated with
 * killProcessTree (on POSIX the command is therefore spawned with detached: true), not just the shell, and the promise
 * resolves within about 5 seconds after the timeout even when some surviving process still holds the output pipes
 * (do not wait for 'close' forever). Result on timeout as before: exitCode 124 and the "timed out after" line.
 * A command that finishes in time behaves exactly as before.
 */
/** Async version of runTestCommand so parallel worktrees do not block the event loop. */
export function runTestCommandAsync(command: string, cwd: string, timeoutMs?: number): Promise<CommandRunResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;

    const child = spawn(command, {
      cwd,
      env,
      shell: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const settle = (code: number | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (grace) clearTimeout(grace);
      if (timedOut) stderr += `\n[bastion] Command timed out after ${timeoutMs}ms.`;
      resolve({
        exitCode: timedOut ? 124 : (code ?? 1),
        stdout,
        stderr,
        durationMs: Date.now() - start,
      });
    };

    let grace: NodeJS.Timeout | null = null;
    const timer = timeoutMs && timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          if (child.pid !== undefined) killProcessTree(child.pid);
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
          grace = setTimeout(() => {
            child.stdout?.destroy();
            child.stderr?.destroy();
            settle(124);
          }, 2000);
        }, timeoutMs)
      : null;

    child.stdout?.on('data', (d) => { stdout += String(d); });
    child.stderr?.on('data', (d) => { stderr += String(d); });
    child.on('error', () => settle(1));
    child.on('close', (code) => settle(code));
  });
}

/** Compute SHA-256 hex digest of a file on disk. */
export function sha256File(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * v1.1: line-ending independent content hash. sha256 hex of the buffer with every CRLF replaced by LF; a buffer that
 * contains a NUL byte is treated as binary and hashed as is.
 */
export function contentHash(buf: Buffer): string {
  const sha = (b: Buffer): string => crypto.createHash('sha256').update(b).digest('hex');
  if (buf.includes(0)) return sha(buf);
  return sha(normalizeCrlf(buf));
}

function normalizeCrlf(buf: Buffer): Buffer {
  const out = Buffer.alloc(buf.length);
  let n = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a) continue; // drop the CR of a CRLF
    out[n++] = buf[i];
  }
  return out.subarray(0, n);
}

function expandLf(buf: Buffer): Buffer {
  const parts: number[] = [];
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a && (i === 0 || buf[i - 1] !== 0x0d)) parts.push(0x0d);
    parts.push(buf[i]);
  }
  return Buffer.from(parts);
}

/**
 * v1.1: true when `expected` equals contentHash(buf), or the raw sha256 of buf, or the raw sha256 of buf with every LF
 * that is not preceded by CR expanded to CRLF (locks written by <= 1.0 on Windows hashed the CRLF working copy while
 * git stores LF). Comparison is case-insensitive on the hex string.
 */
export function hashMatches(buf: Buffer, expected: string): boolean {
  const want = expected.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(want)) return false;
  const sha = (b: Buffer): string => crypto.createHash('sha256').update(b).digest('hex');
  if (contentHash(buf) === want || sha(buf) === want) return true;
  return !buf.includes(0) && sha(expandLf(buf)) === want;
}

/** Convert a simple glob pattern (*, **, ?) into a RegExp matching POSIX relative paths. */
export function globToRegExp(glob: string): RegExp {
  const norm = toPosixPath(glob);
  let regex = '^';
  let i = 0;
  while (i < norm.length) {
    const ch = norm[i];
    if (ch === '*') {
      if (norm[i + 1] === '*') {
        if (norm[i + 2] === '/') {
          regex += '(?:.*/)?';
          i += 3;
          continue;
        }
        regex += '.*';
        i += 2;
        continue;
      }
      regex += '[^/]*';
      i += 1;
      continue;
    }
    if (ch === '?') {
      regex += '[^/]';
      i += 1;
      continue;
    }
    if ('\\^$.|+()[]{}'.includes(ch)) {
      regex += '\\' + ch;
    } else {
      regex += ch;
    }
    i += 1;
  }
  regex += '$';
  return new RegExp(regex);
}

export function matchesAnyGlob(relPath: string, globs: string[]): boolean {
  const posix = toPosixPath(relPath);
  return globs.some((g) => globToRegExp(g).test(posix));
}

const IGNORED_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', 'dist', 'dist-test', 'build', '.bastion']);

/** Walk repo files respecting .gitignore via `git ls-files`, with filesystem fallback. */
export function walkRepoFiles(repoRoot: string): string[] {
  const gitRes = execGit(['ls-files', '--cached', '--others', '--exclude-standard'], repoRoot);
  if (gitRes.ok) {
    return gitRes.stdout
      .split(/\r?\n/)
      .map((s) => toPosixPath(s.trim()))
      .filter((rel) => rel && !rel.startsWith('.bastion/') && fs.existsSync(path.join(repoRoot, rel)))
      .sort();
  }

  const results: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        results.push(toPosixPath(path.relative(repoRoot, full)));
      }
    }
  };
  walk(repoRoot);
  return results.sort();
}
