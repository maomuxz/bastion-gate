import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  status: number;
}

/** Run a git command safely without shell interpolation. */
export function execGit(args: string[], cwd: string): GitResult {
  const res = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    ok: res.status === 0,
    stdout: (res.stdout ?? '').trimEnd(),
    stderr: (res.stderr ?? '').trimEnd(),
    status: res.status ?? 1,
  };
}

/** Normalize a relative path to forward slashes for cross-platform git comparisons. */
export function toPosixPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

/** Return the git repository root directory, or null if not inside a git repo. */
export function getRepoRoot(cwd: string): string | null {
  const res = execGit(['rev-parse', '--show-toplevel'], cwd);
  if (!res.ok || !res.stdout) return null;
  return path.resolve(res.stdout.trim());
}

/** Resolve any git ref (HEAD, branch, commit SHA) to a full 40-char SHA. */
export function resolveRef(ref: string, cwd: string): string | null {
  const res = execGit(['rev-parse', '--verify', `${ref}^{commit}`], cwd);
  return res.ok ? res.stdout.trim() : null;
}

/** Read a file's UTF-8 content from a specific git ref without touching the working tree. */
export function readFileAtRef(ref: string, relPath: string, cwd: string): string | null {
  const posix = toPosixPath(relPath);
  const res = execGit(['show', `${ref}:${posix}`], cwd);
  return res.ok ? res.stdout : null;
}

/** List files changed between two git refs (excluding pure renames confusion via --no-renames). */
export function getChangedFilesBetween(baseRef: string, targetRef: string, cwd: string): string[] {
  const res = execGit(['diff', '--name-only', '--no-renames', `${baseRef}..${targetRef}`], cwd);
  if (!res.ok) throw new Error(`git diff failed: ${res.stderr}`);
  return res.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map(toPosixPath);
}

/** List uncommitted (staged, unstaged, and untracked) files in the working tree. */
export function getDirtyFiles(cwd: string): string[] {
  const res = execGit(['status', '--porcelain', '-uall'], cwd);
  if (!res.ok) throw new Error(`git status failed: ${res.stderr}`);
  const files: string[] = [];
  for (const line of res.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    // Format: XY <path> (or XY old -> new)
    const rawPath = line.slice(3).trim();
    const finalPath = rawPath.includes(' -> ') ? rawPath.split(' -> ').pop()! : rawPath;
    // Strip surrounding quotes if git quoted non-ASCII or spaces
    const unquoted = finalPath.startsWith('"') && finalPath.endsWith('"')
      ? finalPath.slice(1, -1)
      : finalPath;
    files.push(toPosixPath(unquoted));
  }
  return files;
}

/** Check if a file is tracked at a given ref. */
export function fileExistsAtRef(ref: string, relPath: string, cwd: string): boolean {
  const posix = toPosixPath(relPath);
  const res = execGit(['cat-file', '-e', `${ref}:${posix}`], cwd);
  return res.ok;
}
