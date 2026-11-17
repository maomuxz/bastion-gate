import * as fs from 'node:fs';
import * as path from 'node:path';
import { readConfigFromDisk } from '../config.js';
import { getRepoRoot, toPosixPath } from '../git.js';
import { matchesAnyGlob, runTestCommand, walkRepoFiles } from '../runner.js';

export interface MutateOptions {
  cwd: string;
  files?: string[];
  maxMutations?: number;
}

interface Mutant {
  file: string;
  line: number;
  description: string;
  mutatedContent: string;
}

const SOURCE_EXTENSIONS = new Set(['.ts', '.js', '.mjs', '.cjs', '.py', '.go', '.rs', '.dart']);

const MUTATION_RULES: Array<{ pattern: RegExp; replace: string; label: string }> = [
  { pattern: /===/, replace: '!==', label: '=== -> !==' },
  { pattern: /!==/, replace: '===', label: '!== -> ===' },
  { pattern: />=/, replace: '<', label: '>= -> <' },
  { pattern: /<=/, replace: '>', label: '<= -> >' },
  { pattern: /\btrue\b/, replace: 'false', label: 'true -> false' },
  { pattern: /\bfalse\b/, replace: 'true', label: 'false -> true' },
];

function collectMutants(relPath: string, content: string, limit: number): Mutant[] {
  const lines = content.split('\n');
  const mutants: Mutant[] = [];

  for (let i = 0; i < lines.length && mutants.length < limit; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('import ')) {
      continue;
    }

    for (const rule of MUTATION_RULES) {
      if (mutants.length >= limit) break;
      if (!rule.pattern.test(line)) continue;
      const mutatedLine = line.replace(rule.pattern, rule.replace);
      if (mutatedLine === line) continue;

      const copy = [...lines];
      copy[i] = mutatedLine;
      mutants.push({
        file: relPath,
        line: i + 1,
        description: rule.label,
        mutatedContent: copy.join('\n'),
      });
    }
  }

  return mutants;
}

/**
 * Lightweight mutation spot-check: temporarily injects small mutations into
 * non-locked source files and verifies the test suite kills every mutant.
 * Always restores original source files in a finally block.
 */
export function runMutate(opts: MutateOptions): number {
  const repoRoot = getRepoRoot(opts.cwd) ?? path.resolve(opts.cwd);
  const config = readConfigFromDisk(repoRoot);
  const maxMutations = opts.maxMutations ?? 10;

  // Ensure baseline tests pass before mutating
  const baseline = runTestCommand(config.testCommand, repoRoot);
  if (baseline.exitCode !== 0) {
    console.error(`[bastion] Mutation aborted: baseline testCommand already fails (exit ${baseline.exitCode}).`);
    return 1;
  }

  const lockedPatterns = [...config.lockedGlobs, ...config.extraLockedPaths];
  const candidateFiles = opts.files && opts.files.length > 0
    ? opts.files.map(toPosixPath)
    : walkRepoFiles(repoRoot).filter((rel) => {
        const ext = path.extname(rel);
        return SOURCE_EXTENSIONS.has(ext) && !matchesAnyGlob(rel, lockedPatterns);
      });

  const allMutants: Mutant[] = [];
  for (const rel of candidateFiles) {
    if (allMutants.length >= maxMutations) break;
    const full = path.join(repoRoot, rel);
    if (!fs.existsSync(full)) continue;
    const content = fs.readFileSync(full, 'utf8');
    allMutants.push(...collectMutants(rel, content, maxMutations - allMutants.length));
  }

  if (allMutants.length === 0) {
    console.log('[bastion] No mutation points found in target source files.');
    return 0;
  }

  console.log(`[bastion] Running ${allMutants.length} mutation spot-check(s)...`);
  let killed = 0;
  const survived: Mutant[] = [];

  for (const mutant of allMutants) {
    const full = path.join(repoRoot, mutant.file);
    const original = fs.readFileSync(full, 'utf8');
    try {
      fs.writeFileSync(full, mutant.mutatedContent, 'utf8');
      const res = runTestCommand(config.testCommand, repoRoot);
      if (res.exitCode !== 0) {
        killed++;
        console.log(`  [KILLED]   ${mutant.file}:${mutant.line} (${mutant.description})`);
      } else {
        survived.push(mutant);
        console.error(`  [SURVIVED] ${mutant.file}:${mutant.line} (${mutant.description}) — tests still passed!`);
      }
    } finally {
      fs.writeFileSync(full, original, 'utf8');
    }
  }

  console.log(`\n[bastion] Mutation score: ${killed}/${allMutants.length} killed.`);
  if (survived.length > 0) {
    console.error('[bastion] Some mutations survived — tests may have blind spots.');
    return 1;
  }
  return 0;
}
