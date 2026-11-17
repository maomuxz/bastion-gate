import { runGate } from './commands/gate.js';
function main() {
    const inputBase = process.env.INPUT_BASE?.trim();
    const githubBase = process.env.GITHUB_BASE_REF?.trim();
    const baseRef = inputBase || (githubBase ? `origin/${githubBase}` : undefined);
    return runGate({
        cwd: process.cwd(),
        baseRef,
    });
}
process.exitCode = main();
