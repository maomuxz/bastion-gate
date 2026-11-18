import * as fs from 'node:fs';
import * as path from 'node:path';
import { QuestionDraft } from './outbox.js';

export const INBOX_REL_PATH = '.bastion/inbox.json';

/** A tier-3 question waiting for (or answered by) the user. */
export interface InboxItem {
  id: string;
  at: string;
  node: string;
  question: string;
  recommend?: string;
  status: 'open' | 'answered';
  answer?: string;
  answeredAt?: string;
}

export function readInbox(repoRoot: string): InboxItem[] {
  const p = path.join(repoRoot, INBOX_REL_PATH);
  if (!fs.existsSync(p)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
    return Array.isArray(parsed) ? (parsed as InboxItem[]) : [];
  } catch {
    return [];
  }
}

/** True if the node still has an open question (it must not be scheduled). */
export function hasOpenQuestion(repoRoot: string, nodeId: string): boolean {
  return readInbox(repoRoot).some((q) => q.node === nodeId && q.status === 'open');
}

/**
 * Add collected outbox questions to the main repo inbox (.bastion/inbox.json) as open
 * items and return the new items. Synchronous for the same reason as appendDecisions.
 */
export function openQuestions(repoRoot: string, nodeId: string, drafts: QuestionDraft[]): InboxItem[] {
  if (drafts.length === 0) return [];
  const items = readInbox(repoRoot);
  const used = new Set(items.map((q) => q.id));
  const created: InboxItem[] = [];
  let n = items.length;
  for (const d of drafts) {
    let id: string;
    do {
      n++;
      id = `q${n}-${nodeId}`;
    } while (used.has(id));
    used.add(id);
    created.push({
      id,
      at: new Date().toISOString(),
      node: nodeId,
      question: d.question,
      ...(d.recommend ? { recommend: d.recommend } : {}),
      status: 'open',
    });
  }
  writeInbox(repoRoot, [...items, ...created]);
  return created;
}

function writeInbox(repoRoot: string, items: InboxItem[]): void {
  const p = path.join(repoRoot, INBOX_REL_PATH);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(items, null, 2) + '\n', 'utf8');
}

/** Record the user's answer (`bastion answer <id> "<text>"`). Throws if the id is unknown. */
export function answerQuestion(repoRoot: string, id: string, answer: string): InboxItem {
  const items = readInbox(repoRoot);
  const item = items.find((q) => q.id === id);
  if (!item) throw new Error(`answer: no question with id "${id}".`);
  item.status = 'answered';
  item.answer = answer;
  item.answeredAt = new Date().toISOString();
  writeInbox(repoRoot, items);
  return item;
}

/** Answered items for a node, appended to its prompt when it is re-run on --resume. */
export function answersForNode(repoRoot: string, nodeId: string): InboxItem[] {
  return readInbox(repoRoot).filter((q) => q.node === nodeId && q.status === 'answered');
}
