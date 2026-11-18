/**
 * Shrink test-runner output for humans (gate PASS log) and for agents (retry feedback).
 * Contract (v0.4.1):
 * - drop stack-frame lines (lines whose trimmed text starts with "at " followed by a location,
 *   e.g. "    at TestContext.<anonymous> (file:///...)" or "    at node:internal/...")
 * - keep everything else in original order, including assertion messages and summary lines
 * - return at most `maxLines` lines: the LAST maxLines of what is left
 * - normalise \r\n to \n; no trailing newline
 */
export function summarizeTestOutput(text, maxLines) {
    const lines = text.replace(/\r\n/g, '\n').split('\n').filter((l) => !isStackFrame(l));
    while (lines.length > 0 && lines[lines.length - 1] === '')
        lines.pop();
    const cap = Math.max(0, Math.floor(maxLines));
    return (cap === 0 ? [] : lines.slice(-cap)).join('\n');
}
function isStackFrame(line) {
    const t = line.trim().replace(/\s*\{$/, '');
    if (!t.startsWith('at '))
        return false;
    return (/\(.+:\d+:\d+\)$/.test(t) ||
        /\S:\d+:\d+$/.test(t) ||
        /^at async Promise\.\w+ \(index \d+\)$/.test(t) ||
        /\bnode:[\w/.-]+/.test(t));
}
