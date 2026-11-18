import * as fs from 'node:fs';
import * as path from 'node:path';
export const RUN_STATE_REL_PATH = '.bastion/run-state.json';
export function readRunState(repoRoot) {
    const p = path.join(repoRoot, RUN_STATE_REL_PATH);
    if (!fs.existsSync(p))
        return null;
    try {
        return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
    }
    catch {
        return null;
    }
}
export function writeRunState(repoRoot, state) {
    const p = path.join(repoRoot, RUN_STATE_REL_PATH);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(state, null, 2) + '\n', 'utf8');
}
