import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { MAP_DIFF_REL_PATH, MAP_REL_PATH, writeJson, writeText } from '../map.js';
import type { BastionMap } from '../map.js';
import { APPROVAL_REL_PATH, BRIEF_REL_PATH } from './stages.js';
import type { ReviewOptions } from './stages.js';

/** P3: one plain-language page (markdown) a non-programmer can approve: requirement, numbered nodes with summary + acceptance, and the number of planner/blind disagreements from the diff markdown (0 when "No differences."). */
export function renderBrief(map: BastionMap, diffMarkdown: string): string {
  const disagreements = diffMarkdown.split(/\r?\n/).filter((l) => l.startsWith('- ')).length;
  const lines: string[] = ['# Plan brief', '', '## What you asked for', '', map.requirement, '', '## What will be built', ''];
  map.nodes.forEach((n, i) => {
    lines.push(`### ${i + 1}. ${n.title}`, '', n.summary, '');
    if (n.dependsOn && n.dependsOn.length > 0) {
      const names = n.dependsOn.map((id) => {
        const idx = map.nodes.findIndex((x) => x.id === id);
        return idx >= 0 ? `step ${idx + 1}` : id;
      });
      lines.push(`Comes after: ${names.join(', ')}.`, '');
    }
    lines.push('It is done when:', '');
    for (const a of n.acceptance) lines.push(`- ${a}`);
    lines.push('');
  });
  lines.push('## Planner disagreements', '');
  lines.push(
    disagreements === 0
      ? 'Planner and blind planner disagree on: 0 points.'
      : `Planner and blind planner disagree on: ${disagreements} point${disagreements === 1 ? '' : 's'} (see ${MAP_DIFF_REL_PATH}).`,
    '',
  );
  lines.push('To approve this plan run: bastion review --approve', '');
  return lines.join('\n');
}

function sha256File(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** P3: true when .bastion/approval.json exists and its mapSha256 equals the sha256 of the current .bastion/map.json bytes. */
export function isMapApproved(repoRoot: string): boolean {
  try {
    const approval = path.join(repoRoot, APPROVAL_REL_PATH);
    const mapFile = path.join(repoRoot, MAP_REL_PATH);
    if (!fs.existsSync(approval) || !fs.existsSync(mapFile)) return false;
    const a = JSON.parse(fs.readFileSync(approval, 'utf8').replace(/^﻿/, '')) as { mapSha256?: unknown };
    return typeof a.mapSha256 === 'string' && a.mapSha256 === sha256File(mapFile);
  } catch {
    return false;
  }
}

/** P3 `bastion review [--approve]`: writes and prints .bastion/brief.md; --approve writes approval.json {mapSha256, at}. No map -> 1. */
export function runReview(opts: ReviewOptions): number {
  let map: BastionMap | null = null;
  try {
    // Parsed directly (not via readMap) so review does not depend on full map validation.
    const raw = JSON.parse(fs.readFileSync(path.join(opts.cwd, MAP_REL_PATH), 'utf8').replace(/^﻿/, '')) as BastionMap;
    map = raw && typeof raw.requirement === 'string' && Array.isArray(raw.nodes) ? raw : null;
  } catch {
    map = null;
  }
  if (!map) {
    console.error('[bastion] review: no valid .bastion/map.json. Run `bastion map` first.');
    return 1;
  }
  const diffFile = path.join(opts.cwd, MAP_DIFF_REL_PATH);
  const diff = fs.existsSync(diffFile) ? fs.readFileSync(diffFile, 'utf8') : 'No differences.\n';
  const brief = renderBrief(map, diff);
  writeText(opts.cwd, BRIEF_REL_PATH, brief);
  console.log(brief);
  if (opts.approve) {
    writeJson(opts.cwd, APPROVAL_REL_PATH, {
      mapSha256: sha256File(path.join(opts.cwd, MAP_REL_PATH)),
      at: new Date().toISOString(),
    });
    console.log('[bastion] map approved.');
  }
  return 0;
}
