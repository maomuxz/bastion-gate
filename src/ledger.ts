import * as fs from 'node:fs';
import * as path from 'node:path';
import { DecisionDraft } from './outbox.js';

export const DECISIONS_REL_PATH = '.bastion/decisions.json';

/** A tier-2 decision an agent made on the user's behalf. */
export interface DecisionRecord {
  id: string;
  at: string;
  tier: 2;
  node?: string;
  title: string;
  chosen: string;
  why: string;
  undo?: string;
}

export function readDecisions(repoRoot: string): DecisionRecord[] {
  const p = path.join(repoRoot, DECISIONS_REL_PATH);
  if (!fs.existsSync(p)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
    return Array.isArray(parsed) ? (parsed as DecisionRecord[]) : [];
  } catch {
    return [];
  }
}

/**
 * Append collected outbox decisions to the main repo ledger (.bastion/decisions.json)
 * and return the new records. Must be synchronous (read + write with no await between),
 * because parallel nodes finish concurrently.
 */
export function appendDecisions(repoRoot: string, nodeId: string, drafts: DecisionDraft[]): DecisionRecord[] {
  if (!drafts.length) return [];
  const existing = readDecisions(repoRoot);
  const used = new Set(existing.map((d) => d.id));
  let seq = existing.length;
  const now = new Date().toISOString();
  const added: DecisionRecord[] = drafts.map((d) => {
    let id: string;
    do {
      seq += 1;
      id = `d${seq}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    } while (used.has(id));
    used.add(id);
    const rec: DecisionRecord = { id, at: now, tier: 2, node: nodeId, title: d.title, chosen: d.chosen, why: d.why };
    if (d.undo) rec.undo = d.undo;
    return rec;
  });
  const p = path.join(repoRoot, DECISIONS_REL_PATH);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify([...existing, ...added], null, 2) + '\n', 'utf8');
  return added;
}

/** Lines printed by `bastion decisions`, oldest first: what was chosen / why / how to undo. */
export function formatDecisions(records: DecisionRecord[]): string[] {
  const sorted = records
    .map((r, i) => ({ r, i }))
    .sort((a, b) => Date.parse(a.r.at) - Date.parse(b.r.at) || a.i - b.i)
    .map((x) => x.r);
  const lines: string[] = [];
  for (const r of sorted) {
    lines.push(`[${r.at}] ${r.title}${r.node ? ` (node: ${r.node})` : ''}`);
    lines.push(`  chosen: ${r.chosen}`);
    lines.push(`  why: ${r.why}`);
    if (r.undo) lines.push(`  undo: ${r.undo}`);
  }
  return lines;
}
