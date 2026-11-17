import { spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execGit, toPosixPath } from './git.js';
/** Run a test command in the repo root and capture its real exit code. */
export function runTestCommand(command, cwd) {
    const start = Date.now();
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
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
/** Compute SHA-256 hex digest of a file on disk. */
export function sha256File(filePath) {
    const buf = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(buf).digest('hex');
}
/** Convert a simple glob pattern (*, **, ?) into a RegExp matching POSIX relative paths. */
export function globToRegExp(glob) {
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
        }
        else {
            regex += ch;
        }
        i += 1;
    }
    regex += '$';
    return new RegExp(regex);
}
export function matchesAnyGlob(relPath, globs) {
    const posix = toPosixPath(relPath);
    return globs.some((g) => globToRegExp(g).test(posix));
}
const IGNORED_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', 'dist', 'dist-test', 'build', '.bastion']);
/** Walk repo files respecting .gitignore via `git ls-files`, with filesystem fallback. */
export function walkRepoFiles(repoRoot) {
    const gitRes = execGit(['ls-files', '--cached', '--others', '--exclude-standard'], repoRoot);
    if (gitRes.ok) {
        return gitRes.stdout
            .split(/\r?\n/)
            .map((s) => toPosixPath(s.trim()))
            .filter((rel) => rel && !rel.startsWith('.bastion/') && fs.existsSync(path.join(repoRoot, rel)))
            .sort();
    }
    const results = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (IGNORED_DIRS.has(entry.name))
                continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            }
            else if (entry.isFile()) {
                results.push(toPosixPath(path.relative(repoRoot, full)));
            }
        }
    };
    walk(repoRoot);
    return results.sort();
}
