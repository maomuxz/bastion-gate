import { runTestCommand, runTestCommandAsync } from './runner.js';
const TAIL_LINES = 40;
function failure(command, res) {
    const combined = [res.stdout, res.stderr].filter(Boolean).join('\n').replace(/\r\n/g, '\n').trimEnd();
    const lines = combined.split('\n');
    const tail = lines.slice(-TAIL_LINES).join('\n');
    const feedback = `Pre-check failed: ${command} (exit ${res.exitCode})\n` +
        (lines.length > TAIL_LINES ? `--- last ${TAIL_LINES} lines of output ---\n` : '--- output ---\n') +
        tail;
    return { ok: false, failedCommand: command, feedback };
}
/**
 * Run gate pre-checks in order in `cwd`; stop at the first non-zero exit.
 * `checks` must come from the BASELINE config, never from the branch under test.
 */
export function runPreChecks(checks, cwd) {
    for (const command of checks) {
        const res = runTestCommand(command, cwd);
        if (res.exitCode !== 0)
            return failure(command, res);
    }
    return { ok: true, feedback: '' };
}
/** Same contract as runPreChecks, without blocking the event loop. */
export async function runPreChecksAsync(checks, cwd) {
    for (const command of checks) {
        const res = await runTestCommandAsync(command, cwd);
        if (res.exitCode !== 0)
            return failure(command, res);
    }
    return { ok: true, feedback: '' };
}
