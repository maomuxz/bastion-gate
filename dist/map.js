import * as fs from 'node:fs';
import * as path from 'node:path';
/** Project map produced by the planner roles (`bastion map`). Paths are repo-relative, POSIX. */
export const MAP_REL_PATH = '.bastion/map.json';
export const MAPS_DIR_REL = '.bastion/maps';
export const MAP_DIFF_REL_PATH = '.bastion/map-diff.md';
export const INTERFACES_REL_PATH = '.bastion/interfaces.md';
export const ACCEPTANCE_REL_PATH = '.bastion/acceptance.md';
/**
 * Validate an untrusted planner output. Errors are human-readable strings. Rules:
 * version === 1; requirement and interfaces are strings; nodes is a non-empty array;
 * every node has non-empty id/title/summary/interface/testFile/testCommand, files is a non-empty
 * string array, acceptance is a non-empty string array; ids are unique; every dependsOn id exists;
 * no dependency cycle; no file owned by two nodes; no testFile listed in any node's files.
 * On success returns the map with optional fields normalised (dependsOn defaults to []).
 */
export function validateMap(raw) {
    const errors = [];
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        return { ok: false, errors: ['map must be an object'] };
    }
    const r = raw;
    if (r.version !== 1)
        errors.push('version must be 1');
    if (typeof r.requirement !== 'string')
        errors.push('requirement must be a string');
    if (typeof r.interfaces !== 'string')
        errors.push('interfaces must be a string');
    if (!Array.isArray(r.nodes) || r.nodes.length === 0) {
        errors.push('nodes must be a non-empty array');
        return { ok: false, errors };
    }
    const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';
    const strArr = (v) => Array.isArray(v) && v.length > 0 && v.every(nonEmpty);
    const nodes = [];
    r.nodes.forEach((entry, i) => {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
            errors.push(`nodes[${i}] must be an object`);
            return;
        }
        const n = entry;
        const label = nonEmpty(n.id) ? n.id : `nodes[${i}]`;
        for (const f of ['id', 'title', 'summary', 'interface', 'testFile', 'testCommand']) {
            if (!nonEmpty(n[f]))
                errors.push(`node ${label}: ${f} must be a non-empty string`);
        }
        for (const f of ['files', 'acceptance']) {
            if (!strArr(n[f]))
                errors.push(`node ${label}: ${f} must be a non-empty array of non-empty strings`);
        }
        let dependsOn = [];
        if (n.dependsOn !== undefined) {
            if (Array.isArray(n.dependsOn) && n.dependsOn.every(nonEmpty))
                dependsOn = n.dependsOn.slice();
            else
                errors.push(`node ${label}: dependsOn must be an array of strings`);
        }
        const node = {
            id: n.id,
            title: n.title,
            summary: n.summary,
            files: Array.isArray(n.files) ? n.files.slice() : [],
            dependsOn,
            interface: n.interface,
            acceptance: Array.isArray(n.acceptance) ? n.acceptance.slice() : [],
            testFile: n.testFile,
            testCommand: n.testCommand,
        };
        if (n.split === true)
            node.split = true;
        nodes.push(node);
    });
    const ids = new Set();
    for (const n of nodes) {
        if (!nonEmpty(n.id))
            continue;
        if (ids.has(n.id))
            errors.push(`duplicate node id: ${n.id} (ids must be unique)`);
        ids.add(n.id);
    }
    for (const n of nodes) {
        for (const d of n.dependsOn ?? []) {
            if (!ids.has(d))
                errors.push(`node ${n.id}: dependsOn unknown node "${d}"`);
        }
    }
    const byId = new Map();
    for (const n of nodes)
        if (nonEmpty(n.id) && !byId.has(n.id))
            byId.set(n.id, n);
    const state = new Map();
    const reported = new Set();
    const visit = (id, stack) => {
        state.set(id, 1);
        stack.push(id);
        for (const d of byId.get(id)?.dependsOn ?? []) {
            if (!byId.has(d))
                continue;
            const st = state.get(d);
            if (st === 1) {
                const cyc = stack.slice(stack.indexOf(d)).concat(d);
                const key = cyc.join('>');
                if (!reported.has(key)) {
                    reported.add(key);
                    errors.push(`dependency cycle: ${cyc.join(' -> ')}`);
                }
            }
            else if (st === undefined)
                visit(d, stack);
        }
        stack.pop();
        state.set(id, 2);
    };
    for (const id of byId.keys())
        if (state.get(id) === undefined)
            visit(id, []);
    const owner = new Map();
    for (const n of nodes) {
        for (const f of n.files) {
            if (!nonEmpty(f))
                continue;
            const o = owner.get(f);
            if (o === undefined)
                owner.set(f, n.id);
            else if (o !== n.id)
                errors.push(`file ${f} is owned by both ${o} and ${n.id}`);
        }
    }
    for (const n of nodes) {
        if (nonEmpty(n.testFile) && owner.has(n.testFile)) {
            errors.push(`node ${n.id}: testFile ${n.testFile} is listed in files of node ${owner.get(n.testFile)}`);
        }
    }
    if (errors.length > 0)
        return { ok: false, errors };
    return {
        ok: true,
        map: { version: 1, requirement: r.requirement, interfaces: r.interfaces, nodes },
    };
}
function ownerMap(m) {
    const o = new Map();
    for (const n of m.nodes)
        for (const f of n.files)
            if (!o.has(f))
                o.set(f, n.id);
    return o;
}
/** Compare the planner map (A) with the blind map (B). Nodes are matched by id. */
export function diffMaps(a, b) {
    const aNodes = new Map(a.nodes.map((n) => [n.id, n]));
    const bNodes = new Map(b.nodes.map((n) => [n.id, n]));
    const onlyInA = a.nodes.filter((n) => !bNodes.has(n.id)).map((n) => n.id);
    const onlyInB = b.nodes.filter((n) => !aNodes.has(n.id)).map((n) => n.id);
    const fmt = (d) => `[${d.join(', ')}]`;
    const norm = (d) => [...new Set(d ?? [])].sort();
    const dependencyDiffs = [];
    for (const n of a.nodes) {
        const bn = bNodes.get(n.id);
        if (!bn)
            continue;
        const da = norm(n.dependsOn);
        const db = norm(bn.dependsOn);
        if (JSON.stringify(da) !== JSON.stringify(db)) {
            dependencyDiffs.push(`${n.id}: A depends on ${fmt(da)} / B depends on ${fmt(db)}`);
        }
    }
    const oa = ownerMap(a);
    const ob = ownerMap(b);
    const ownershipDiffs = [];
    for (const f of new Set([...oa.keys(), ...ob.keys()])) {
        const x = oa.get(f);
        const y = ob.get(f);
        if (x === y)
            continue;
        ownershipDiffs.push(`${f}: A owns by ${x ?? '(nobody)'} / B owns by ${y ?? '(nobody)'}`);
    }
    return { onlyInA, onlyInB, dependencyDiffs, ownershipDiffs };
}
function finish(lines) {
    return lines.join('\n').replace(/\n+$/, '') + '\n';
}
/**
 * Disagreements the structural diff cannot see (v1.0, F9), for nodes present in both maps (matched by id):
 * one line per node whose `interface` text differs after collapsing all whitespace runs to one space and trimming,
 * e.g. `n2: interface differs`, and one line per node whose acceptance lists differ as sets of trimmed sentences,
 * e.g. `n2: acceptance differs (A has 3, B has 4; only in A: "...", only in B: "...")` listing every differing sentence.
 * Node order follows map A. Identical maps -> [].
 */
export function diffMapDetails(a, b) {
    const norm = (s) => s.replace(/\s+/g, ' ').trim();
    const bById = new Map(b.nodes.map((n) => [n.id, n]));
    const out = [];
    for (const na of a.nodes) {
        const nb = bById.get(na.id);
        if (!nb)
            continue;
        if (norm(na.interface) !== norm(nb.interface))
            out.push(`${na.id}: interface differs`);
        const sa = new Set(na.acceptance.map((s) => s.trim()));
        const sb = new Set(nb.acceptance.map((s) => s.trim()));
        const onlyA = [...sa].filter((s) => !sb.has(s));
        const onlyB = [...sb].filter((s) => !sa.has(s));
        if (onlyA.length === 0 && onlyB.length === 0)
            continue;
        const q = (xs) => xs.map((s) => `"${s}"`).join(', ');
        out.push(`${na.id}: acceptance differs (A has ${na.acceptance.length}, B has ${nb.acceptance.length}; only in A: ${q(onlyA)}, only in B: ${q(onlyB)})`);
    }
    return out;
}
/**
 * Markdown for .bastion/map-diff.md. Starts with "# Map diff". When every list is empty the body
 * contains the line "No differences.". Otherwise one "## " section per non-empty list
 * ("Only in planner map", "Only in blind map", "Dependencies", "File ownership") with "- " items.
 */
export function renderMapDiff(diff) {
    const sections = [
        ['Only in planner map', diff.onlyInA],
        ['Only in blind map', diff.onlyInB],
        ['Dependencies', diff.dependencyDiffs],
        ['File ownership', diff.ownershipDiffs],
    ];
    const lines = ['# Map diff', ''];
    const non = sections.filter(([, items]) => items.length > 0);
    if (non.length === 0) {
        lines.push('No differences.');
    }
    else {
        for (const [title, items] of non) {
            lines.push(`## ${title}`, '');
            for (const it of items)
                lines.push(`- ${it}`);
            lines.push('');
        }
    }
    return finish(lines);
}
/** Markdown for .bastion/interfaces.md: "# Interfaces", the shared interfaces, then "## <id> <title>" + node interface per node. */
export function renderInterfaces(map) {
    const out = ['# Interfaces', '', map.interfaces.trim(), ''];
    for (const n of map.nodes)
        out.push(`## ${n.id} ${n.title}`, '', n.interface.trim(), '');
    return finish(out);
}
/** Markdown for .bastion/acceptance.md: "# Acceptance", then "## <id> <title>" and one "- <sentence>" line per acceptance item. */
export function renderAcceptance(map) {
    const out = ['# Acceptance', ''];
    for (const n of map.nodes) {
        out.push(`## ${n.id} ${n.title}`, '');
        for (const a of n.acceptance)
            out.push(`- ${a}`);
        out.push('');
    }
    return finish(out);
}
/**
 * Turn a validated map into a bastion plan: one plan node per map node, same id/title/dependsOn,
 * testCommand = node.testCommand, tier 1. The prompt must contain: the summary, the line
 * "Edit only: <files joined by ', '>", the node interface, every acceptance sentence,
 * "Locked tests: <testFile>" and "Your node test command: <testCommand>".
 */
export function mapToPlan(map) {
    return {
        version: 1,
        nodes: map.nodes.map((n) => ({
            id: n.id,
            title: n.title,
            dependsOn: n.dependsOn ?? [],
            testCommand: n.testCommand,
            tier: 1,
            prompt: [
                n.summary,
                '',
                `Edit only: ${n.files.join(', ')}`,
                '',
                'Interface:',
                n.interface,
                '',
                'Acceptance:',
                ...n.acceptance.map((a) => `- ${a}`),
                '',
                `Locked tests: ${n.testFile}`,
                `Your node test command: ${n.testCommand}`,
            ].join('\n'),
        })),
    };
}
export function readMap(repoRoot) {
    const p = path.join(repoRoot, MAP_REL_PATH);
    if (!fs.existsSync(p))
        return null;
    const v = validateMap(JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')));
    return v.ok ? v.map : null;
}
export function writeJson(repoRoot, rel, value) {
    const p = path.join(repoRoot, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(value, null, 2) + '\n', 'utf8');
}
export function writeText(repoRoot, rel, text) {
    const p = path.join(repoRoot, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text.endsWith('\n') ? text : text + '\n', 'utf8');
}
