import * as fs from 'node:fs';
import * as path from 'node:path';
/**
 * Outbox hand-off: an agent running inside a node worktree never writes the main
 * repository. `bastion decide` / `bastion ask` append to per-node files under the
 * worktree's `.bastion/outbox/`; the orchestrator collects them after each attempt.
 */
export const OUTBOX_REL_DIR = '.bastion/outbox';
export function decisionsOutboxPath(worktreeDir, nodeId) {
    return path.join(worktreeDir, OUTBOX_REL_DIR, `${nodeId}.decisions.json`);
}
export function questionsOutboxPath(worktreeDir, nodeId) {
    return path.join(worktreeDir, OUTBOX_REL_DIR, `${nodeId}.tier3.json`);
}
function readArray(file) {
    if (!fs.existsSync(file))
        return [];
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
        return Array.isArray(parsed) ? parsed : [];
    }
    catch {
        return [];
    }
}
function appendArray(file, item) {
    const items = readArray(file);
    items.push(item);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(items, null, 2) + '\n', 'utf8');
}
export function writeDecisionToOutbox(worktreeDir, nodeId, draft) {
    appendArray(decisionsOutboxPath(worktreeDir, nodeId), draft);
}
export function writeQuestionToOutbox(worktreeDir, nodeId, draft) {
    appendArray(questionsOutboxPath(worktreeDir, nodeId), draft);
}
/** Read and remove a node's outbox files, so the next attempt starts empty. */
export function collectOutbox(worktreeDir, nodeId) {
    const dPath = decisionsOutboxPath(worktreeDir, nodeId);
    const qPath = questionsOutboxPath(worktreeDir, nodeId);
    const decisions = readArray(dPath).filter((d) => d && typeof d.title === 'string' && typeof d.chosen === 'string' && typeof d.why === 'string');
    const questions = readArray(qPath).filter((q) => q && typeof q.question === 'string');
    for (const p of [dPath, qPath]) {
        if (fs.existsSync(p))
            fs.rmSync(p, { force: true });
    }
    return { decisions, questions };
}
function resolveNodeId(opts) {
    const id = opts.nodeId ?? process.env.BASTION_NODE_ID;
    return id && id.trim() ? id.trim() : null;
}
/** `bastion decide` - run by an agent inside a node to record a tier-2 decision. */
export function runDecide(opts) {
    const nodeId = resolveNodeId(opts);
    if (!nodeId) {
        console.error('[bastion] decide: no node id (run inside `bastion run`, or pass --node <id>).');
        return 1;
    }
    const title = opts.title?.trim();
    const chosen = opts.chosen?.trim();
    const why = opts.why?.trim();
    if (!title || !chosen || !why) {
        console.error('[bastion] decide: --title, --chosen and --why are required.');
        return 1;
    }
    const undo = opts.undo?.trim();
    writeDecisionToOutbox(opts.cwd, nodeId, { title, chosen, why, ...(undo ? { undo } : {}) });
    console.log(`[bastion] Decision recorded for ${nodeId}: ${title}`);
    return 0;
}
/** `bastion ask` - run by an agent inside a node to raise a tier-3 question and pause the node. */
export function runAsk(opts) {
    const nodeId = resolveNodeId(opts);
    if (!nodeId) {
        console.error('[bastion] ask: no node id (run inside `bastion run`, or pass --node <id>).');
        return 1;
    }
    const question = opts.question?.trim();
    if (!question) {
        console.error('[bastion] ask: --question is required.');
        return 1;
    }
    const recommend = opts.recommend?.trim();
    writeQuestionToOutbox(opts.cwd, nodeId, { question, ...(recommend ? { recommend } : {}) });
    console.log(`[bastion] Question queued for ${nodeId}. This node will pause until a human answers.`);
    return 0;
}
