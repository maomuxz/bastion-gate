import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readConfigFromDisk } from '../config.js';
import { execGit, getDirtyFiles, getRepoRoot, gitIdentityArgs } from '../git.js';
import {
  ACCEPTANCE_REL_PATH,
  INTERFACES_REL_PATH,
  MAP_DIFF_REL_PATH,
  MAP_REL_PATH,
  mapToPlan,
  renderAcceptance,
  renderInterfaces,
  validateMap,
  writeJson,
  writeText,
} from '../map.js';
import type { BastionMap } from '../map.js';
import { resolveAgentCommand, runRole } from '../roles.js';
import { APPROVAL_REL_PATH } from './stages.js';
import type { ContractOptions } from './stages.js';

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && x.length > 0);
const fail = (msg: string): number => {
  console.error(`[bastion] contract: ${msg}`);
  return 1;
};

export const CONTRACT_OUTPUT_REL_PATH = '.bastion/maps/contract.json';
export const VILLAGE_NODE_ID = 'village';

/** What the contract role must write to BASTION_OUTPUT. */
export interface ContractOutput {
  /** Stub files the role created (repo-relative, POSIX), holding only the public surface. */
  files: string[];
  /** The single acceptance test file the tester will write later. Must not exist yet and must not be in `files`. */
  testFile: string;
  /** The thin public interface as markdown (signatures, CLI strings, file formats). */
  interface: string;
  /** Plain acceptance sentences. */
  acceptance: string[];
}

/**
 * Validate an untrusted contract output: an object whose `files` is a non-empty array of non-empty strings, `testFile`
 * a non-empty string that is not in `files`, `interface` a non-empty (after trim) string and `acceptance` a non-empty
 * array of non-empty strings. Backslashes in paths are normalised to '/'. Returns the cleaned value or null.
 */
export function parseContractOutput(raw: unknown): ContractOutput | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (!isStrings(o.files) || typeof o.testFile !== 'string' || !o.testFile) return null;
  if (typeof o.interface !== 'string' || !o.interface.trim()) return null;
  if (!isStrings(o.acceptance)) return null;
  const files = o.files.map((f) => f.replace(/\\/g, '/'));
  const testFile = o.testFile.replace(/\\/g, '/');
  if (files.includes(testFile)) return null;
  return { files, testFile, interface: o.interface, acceptance: [...o.acceptance] };
}

/**
 * v1.1 village tier, `bastion contract "<requirement>"`: ONE call replaces `bastion map` + `bastion scaffold`.
 * No map of blocks is drawn; a single role call fixes the thin public surface and writes it as stub files, so that the
 * tester cannot silently decide the interface.
 *
 * Steps (any failure prints `[bastion] contract: ...` to stderr and returns 1):
 * 1. Needs a git repo, a readable config and a non-blank requirement. Writes the requirement verbatim to
 *    .bastion/requirement.md.
 * 2. Calls runRole(resolveAgentCommand(config, 'planner'), 'planner', { label: 'contract', cwd: root,
 *    outputPath: <root>/.bastion/maps/contract.json }) after deleting an old output. The prompt contains the requirement
 *    verbatim and the top-level file names of the repo, and tells the role: write stub files for the public surface only
 *    (what the requirement itself names or a user/test must call: exported functions, CLI commands, file formats); do not
 *    design internal modules or split the work into parts; placeholder bodies only, no real logic; the files must
 *    import/compile so tests can run and fail on assertions; do not write tests; do not commit; then write the
 *    ContractOutput JSON (shape shown in the prompt) to the BASTION_OUTPUT path.
 * 3. Role exit != 0, or an output parseContractOutput rejects -> 1. Every listed file must exist and be non-empty, and
 *    `testFile` must not exist -> else 1. The role may not have touched anything else: every path of
 *    `git status --porcelain --untracked-files=all` must be a listed file or lie under .bastion/ -> else 1, naming the paths.
 * 4. Builds a one-node BastionMap: { version: 1, requirement, interfaces: output.interface, nodes: [{ id: 'village',
 *    title: 'Whole project', summary: 'Implement the whole requirement in one session.', files, interface, acceptance,
 *    testFile, testCommand: config.testCommand }] }. It must pass validateMap (else 1). Writes .bastion/map.json,
 *    .bastion/interfaces.md (renderInterfaces), .bastion/acceptance.md (renderAcceptance), .bastion/plan.json (mapToPlan)
 *    and .bastion/map-diff.md with exactly `# Map diff\n\nSingle contract (village tier): no second map.\n`.
 * 5. Approves it without a human stop: writes .bastion/approval.json { mapSha256, at, by: 'village-tier' } in the same
 *    format `bastion review --approve` uses, so isMapApproved(root) is true.
 * 6. Commits the stub files only, message `chore(bastion): village contract stubs`, passing
 *    `-c user.name=bastion -c user.email=bastion@local` when the repo has no user.email configured.
 * Prints `[bastion] contract: <n> stub file(s), tests will go to <testFile>.` and returns 0.
 */
export async function runContract(opts: ContractOptions): Promise<number> {
  const root = getRepoRoot(opts.cwd);
  if (!root) return fail('not inside a git repository.');
  let config;
  try {
    config = readConfigFromDisk(root);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
  const requirement = opts.requirement;
  if (!requirement || !requirement.trim()) return fail('a non-blank requirement is required.');
  const command = resolveAgentCommand(config, 'planner');
  if (!command) return fail('no planner agent configured (roles.planner or agentCommand).');

  const reqPath = path.join(root, '.bastion', 'requirement.md');
  fs.mkdirSync(path.dirname(reqPath), { recursive: true });
  fs.writeFileSync(reqPath, requirement, 'utf8');

  const outputPath = path.join(root, CONTRACT_OUTPUT_REL_PATH);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.rmSync(outputPath, { force: true });

  const topLevel = fs.readdirSync(root).filter((n) => n !== '.git').sort();
  const prompt = [
    'You are fixing the public contract of a small project BEFORE any implementation or test exists.',
    '',
    '## Requirement',
    requirement,
    '',
    '## Top-level files of the repo',
    ...topLevel.map((n) => `- ${n}`),
    '',
    '## Rules',
    '- Write stub files for the public surface only: what the requirement itself names or what a user/test must call (exported functions, CLI commands, file formats).',
    '- Do not design internal modules and do not split the work into parts.',
    '- Placeholder bodies only (e.g. throw new Error("not implemented") or a trivial return), no real logic.',
    '- The files must import/compile so that tests can run and fail on assertions.',
    '- Do not write tests. Do not commit.',
    '- Then write this JSON to the path in BASTION_OUTPUT:',
    '```json',
    '{',
    '  "files": ["<repo-relative stub file>", "..."],',
    '  "testFile": "<the single acceptance test file the tester will write later; must not exist yet and must not be in files>",',
    '  "interface": "<the thin public interface as markdown: signatures, CLI strings, file formats>",',
    '  "acceptance": ["<plain acceptance sentence>", "..."]',
    '}',
    '```',
    '',
  ].join('\n');

  const timeoutMinutes = opts.timeoutMinutes ?? config.timeoutMinutes;
  const res = await runRole(command, 'planner', {
    prompt,
    cwd: root,
    repoRoot: root,
    label: 'contract',
    outputPath,
    ...(timeoutMinutes && timeoutMinutes > 0 ? { timeoutMs: timeoutMinutes * 60_000 } : {}),
  });
  if (res.exitCode !== 0) return fail(`planner failed (exit ${res.exitCode}${res.timedOut ? ', timed out' : ''}).`);

  let rawOut: unknown = null;
  try {
    rawOut = JSON.parse(fs.readFileSync(outputPath, 'utf8').replace(/^﻿/, ''));
  } catch {
    rawOut = null;
  }
  const output = parseContractOutput(rawOut);
  if (!output) return fail('the planner wrote no valid contract output.');

  const bad = output.files.filter((f) => {
    try {
      return fs.statSync(path.join(root, f)).size === 0;
    } catch {
      return true;
    }
  });
  if (bad.length > 0) return fail(`listed stub file(s) missing or empty: ${bad.join(', ')}`);
  if (fs.existsSync(path.join(root, output.testFile))) return fail(`testFile already exists: ${output.testFile}`);

  const allowed = new Set(output.files);
  let stray: string[];
  try {
    stray = getDirtyFiles(root).filter((f) => !allowed.has(f) && !f.startsWith('.bastion/'));
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
  if (stray.length > 0) return fail(`the planner touched files outside the contract: ${stray.join(', ')}`);

  const map: BastionMap = {
    version: 1,
    requirement,
    interfaces: output.interface,
    nodes: [
      {
        id: VILLAGE_NODE_ID,
        title: 'Whole project',
        summary: 'Implement the whole requirement in one session.',
        files: output.files,
        interface: output.interface,
        acceptance: output.acceptance,
        testFile: output.testFile,
        testCommand: config.testCommand,
      },
    ],
  };
  const v = validateMap(map);
  if (!v.ok) return fail(`invalid map: ${v.errors.join('; ')}`);

  writeJson(root, MAP_REL_PATH, map);
  writeText(root, INTERFACES_REL_PATH, renderInterfaces(map));
  writeText(root, ACCEPTANCE_REL_PATH, renderAcceptance(map));
  writeJson(root, '.bastion/plan.json', mapToPlan(map));
  fs.writeFileSync(path.join(root, MAP_DIFF_REL_PATH), '# Map diff\n\nSingle contract (village tier): no second map.\n', 'utf8');
  writeJson(root, APPROVAL_REL_PATH, {
    mapSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, MAP_REL_PATH))).digest('hex'),
    at: new Date().toISOString(),
    by: 'village-tier',
  });

  const add = execGit(['add', '--', ...output.files], root);
  if (!add.ok) return fail(`git add failed: ${add.stderr}`);
  const commit = execGit([...gitIdentityArgs(root), 'commit', '-m', 'chore(bastion): village contract stubs', '--', ...output.files], root);
  if (!commit.ok) return fail(`git commit failed: ${commit.stderr || commit.stdout}`);

  console.log(`[bastion] contract: ${output.files.length} stub file(s), tests will go to ${output.testFile}.`);
  return 0;
}
