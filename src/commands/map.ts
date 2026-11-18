import * as fs from 'node:fs';
import * as path from 'node:path';
import { readConfigFromDisk } from '../config.js';
import { getRepoRoot } from '../git.js';
import {
  ACCEPTANCE_REL_PATH,
  BastionMap,
  diffMaps,
  INTERFACES_REL_PATH,
  MAP_DIFF_REL_PATH,
  MAP_REL_PATH,
  MAPS_DIR_REL,
  mapToPlan,
  MapValidation,
  readMap,
  renderAcceptance,
  renderInterfaces,
  renderMapDiff,
  diffMapDetails,
  validateMap,
  writeJson,
  writeText,
} from '../map.js';
import { resolveAgentCommand, runRole } from '../roles.js';
import { splitNode } from '../split.js';
import type { MapOptions } from './stages.js';

const REQUIREMENT_REL_PATH = '.bastion/requirement.md';
const APPROVAL_REL = '.bastion/approval.json';
const PLAN_REL_PATH = '.bastion/plan.json';

const SCHEMA_TEXT = `{
  "version": 1,
  "requirement": "<the requirement, restated>",
  "interfaces": "<markdown: shared contracts - types, file layout, conventions>",
  "nodes": [
    {
      "id": "<unique short id, e.g. n1>",
      "title": "<short title>",
      "summary": "<one or two plain sentences: what this node delivers>",
      "files": ["<repo-relative POSIX source files this node owns>"],
      "dependsOn": ["<ids of nodes that must be finished first>"],
      "interface": "<markdown: exact public interface - signatures, types, CLI strings>",
      "acceptance": ["<plain-language, testable acceptance sentence>"],
      "testFile": "<test file the tester will write, not listed in any node's files>",
      "testCommand": "<command that runs this node's tests>",
      "split": false
    }
  ]
}`;

const RULES = `Rules:
- Every source file is owned by exactly one node (no file appears in two nodes' "files").
- Keep nodes small: one focused piece of work each. Set "split": true only for a node that is still too big.
- "dependsOn" must reference existing node ids and must not form a cycle; omit or use [] for independent nodes.
- Give the exact interface of each node (signatures, types, CLI strings) so nodes can be built in parallel.
- Acceptance items are plain, testable sentences; each one becomes at least one test.
- Every node has its own "testFile" (never listed in any node's "files") and a "testCommand" that runs it.
- Do not implement anything. Only write the map.`;

function topLevelFiles(root: string): string[] {
  const skip = new Set(['.git', 'node_modules', '.bastion']);
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => !skip.has(e.name))
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort();
  } catch {
    return [];
  }
}

function buildPrompt(kind: 'planner' | 'blind', requirement: string, files: string[], splitting: boolean): string {
  const intro =
    kind === 'planner'
      ? 'You are the planner. Break the requirement below into a project map: a small dependency graph of nodes, each owned by one worker.'
      : 'You are an independent second planner working on your own. Break the requirement below into a project map: a small dependency graph of nodes, each owned by one worker.';
  const scope = splitting
    ? 'This is a sub-map: it decomposes one larger node into smaller parts. Use short ids (e.g. a, b); they are prefixed with the parent id afterwards.'
    : '';
  const lines = [
    intro,
    ...(scope ? ['', scope] : []),
    '',
    '## Requirement',
    '',
    requirement.trim(),
    '',
    '## Top-level files in the repository',
    '',
    files.length > 0 ? files.map((f) => `- ${f}`).join('\n') : '(empty)',
    '',
    '## Output',
    '',
    'Write ONE JSON document to the path in the BASTION_OUTPUT environment variable (the file named by {output}). It must match this BastionMap schema:',
    '',
    '```json',
    SCHEMA_TEXT,
    '```',
    '',
    RULES,
    '',
  ];
  return lines.join('\n');
}

function readOutput(file: string): MapValidation {
  if (!fs.existsSync(file)) return { ok: false, errors: [`no output file was written at ${file}`] };
  try {
    return validateMap(JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')));
  } catch (e) {
    return { ok: false, errors: [`output is not valid JSON: ${(e as Error).message}`] };
  }
}

function writeOutputs(root: string, map: BastionMap, diffMd: string): void {
  writeJson(root, MAP_REL_PATH, map);
  writeText(root, MAP_DIFF_REL_PATH, diffMd);
  writeText(root, INTERFACES_REL_PATH, renderInterfaces(map));
  writeText(root, ACCEPTANCE_REL_PATH, renderAcceptance(map));
  writeJson(root, PLAN_REL_PATH, mapToPlan(map));
  fs.rmSync(path.join(root, APPROVAL_REL), { force: true });
}

function renderDiffFor(a: BastionMap, b: MapValidation): string {
  if (b.ok) {
    let md = renderMapDiff(diffMaps(a, b.map));
    const details = diffMapDetails(a, b.map);
    if (details.length > 0) {
      md = md.replace(/\n?No differences\.\n?/, '\n').trimEnd() + '\n\n## Interfaces and acceptance\n\n' + details.map((d) => `- ${d}`).join('\n') + '\n';
    }
    return md;
  }
  const lines = ['# Map diff', '', 'The blind map was invalid, so it could not be compared with the planner map.', '', '## Blind map errors', ''];
  for (const e of b.errors) lines.push(`- ${e}`);
  return lines.join('\n') + '\n';
}

export async function runMap(opts: MapOptions): Promise<number> {
  const root = getRepoRoot(opts.cwd) ?? opts.cwd;
  const splitting = opts.parent !== undefined;
  if (!splitting && !(opts.requirement && opts.requirement.trim())) {
    console.error('[bastion] map: a requirement is required (bastion map "<requirement>").');
    return 1;
  }
  let config;
  try {
    config = readConfigFromDisk(root);
  } catch (e) {
    console.error(`[bastion] map: ${(e as Error).message}`);
    return 1;
  }
  const plannerCmd = resolveAgentCommand(config, 'planner');
  if (!plannerCmd) {
    console.error('[bastion] map: no planner command configured (roles.planner or agentCommand).');
    return 1;
  }
  const blindCmd = resolveAgentCommand(config, 'blind') ?? plannerCmd;

  let requirement = opts.requirement ?? '';
  let base: BastionMap | null = null;
  let tag = '';
  if (splitting) {
    const parentId = opts.parent as string;
    try {
      base = readMap(root);
    } catch {
      base = null;
    }
    if (!base) {
      console.error(`[bastion] map: ${MAP_REL_PATH} is missing or invalid; run "bastion map" first.`);
      return 1;
    }
    const node = base.nodes.find((n) => n.id === parentId);
    if (!node) {
      console.error(`[bastion] map: unknown node "${parentId}".`);
      return 1;
    }
    requirement = [
      `Split the node "${node.title}" (id ${node.id}) into smaller parts.`,
      '',
      `Summary: ${node.summary}`,
      '',
      'Interface of the node (the parts together must keep it):',
      node.interface,
      '',
      'Acceptance of the node (the parts together must satisfy it):',
      ...node.acceptance.map((a) => `- ${a}`),
      '',
      `Files currently owned by the node: ${node.files.join(', ')}`,
      '',
      `Overall project requirement: ${base.requirement}`,
    ].join('\n');
    tag = `split-${parentId}-`;
  } else {
    writeText(root, REQUIREMENT_REL_PATH, requirement);
  }

  const files = topLevelFiles(root);
  const timeoutMs = opts.timeoutMinutes && opts.timeoutMinutes > 0 ? opts.timeoutMinutes * 60_000 : undefined;
  const outA = path.join(root, MAPS_DIR_REL, `${tag}map-a.json`);
  const outB = path.join(root, MAPS_DIR_REL, `${tag}map-b.json`);
  fs.mkdirSync(path.dirname(outA), { recursive: true });
  fs.rmSync(outA, { force: true });
  fs.rmSync(outB, { force: true });

  await Promise.all([
    runRole(plannerCmd, 'planner', {
      prompt: buildPrompt('planner', requirement, files, splitting),
      cwd: root, repoRoot: root, label: `${tag}map-a`, outputPath: outA, timeoutMs,
    }),
    runRole(blindCmd, 'blind', {
      prompt: buildPrompt('blind', requirement, files, splitting),
      cwd: root, repoRoot: root, label: `${tag}map-b`, outputPath: outB, timeoutMs,
    }),
  ]);

  const a = readOutput(outA);
  if (!a.ok) {
    console.error('[bastion] map: the planner map is invalid:');
    for (const e of a.errors) console.error(`  - ${e}`);
    return 1;
  }
  const b = readOutput(outB);
  if (!b.ok) console.error(`[bastion] map: the blind map is invalid (${b.errors.length} error(s)); continuing with the planner map.`);

  let finalMap = a.map;
  if (splitting && base) {
    try {
      finalMap = splitNode(base, opts.parent as string, a.map);
    } catch (e) {
      console.error(`[bastion] map: cannot split "${opts.parent}": ${(e as Error).message}`);
      return 1;
    }
    const check = validateMap(finalMap);
    if (!check.ok) {
      console.error('[bastion] map: the split map is invalid:');
      for (const e of check.errors) console.error(`  - ${e}`);
      return 1;
    }
    finalMap = check.map;
  }

  writeOutputs(root, finalMap, renderDiffFor(a.map, b));
  console.log(`[bastion] map: ${finalMap.nodes.length} node(s) written to ${MAP_REL_PATH}. Review with "bastion review".`);
  return 0;
}
