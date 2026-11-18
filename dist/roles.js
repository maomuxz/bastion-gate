import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
const CLI_PATH = fileURLToPath(new URL('./cli.js', import.meta.url));
/**
 * Run a role command (planner / blind / tester / worker / qa) once. The command template may use
 * {promptFile} and {output}; env gets BASTION_ROLE, BASTION_NODE_ID (= label), BASTION_PROMPT_FILE,
 * BASTION_OUTPUT, BASTION_CLI and BASTION_HOME. stdout+stderr go to .bastion/logs/<label>.log.
 */
export function runRole(command, role, call) {
    const logsDir = path.join(call.repoRoot, '.bastion', 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const promptFile = path.join(logsDir, `${call.label}-prompt.txt`);
    fs.writeFileSync(promptFile, call.prompt, 'utf8');
    if (call.outputPath)
        fs.mkdirSync(path.dirname(call.outputPath), { recursive: true });
    const cmd = command.replace(/\{promptFile\}/g, promptFile).replace(/\{output\}/g, call.outputPath ?? '');
    const env = {
        ...process.env,
        BASTION_ROLE: role,
        BASTION_NODE_ID: call.label,
        BASTION_PROMPT_FILE: promptFile,
        BASTION_OUTPUT: call.outputPath ?? '',
        BASTION_CLI: CLI_PATH,
        BASTION_HOME: call.repoRoot,
        BASTION_ATTEMPT: '1',
    };
    delete env.NODE_TEST_CONTEXT;
    return new Promise((resolve) => {
        const log = fs.createWriteStream(path.join(logsDir, `${call.label}.log`), { flags: 'w' });
        const child = spawn(cmd, { cwd: call.cwd, env, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        let timedOut = false;
        const timer = call.timeoutMs && call.timeoutMs > 0
            ? setTimeout(() => { timedOut = true; child.kill(); }, call.timeoutMs)
            : null;
        const onData = (d) => { const t = String(d); output += t; log.write(t); };
        child.stdout?.on('data', onData);
        child.stderr?.on('data', onData);
        child.on('close', (code) => {
            if (timer)
                clearTimeout(timer);
            log.end();
            resolve({ exitCode: timedOut ? 124 : (code ?? 1), output, timedOut });
        });
    });
}
/**
 * Pick the command for a role.
 * Contract (v0.4): explicit (--agent) > config.roles[role] > config.agentCommand.
 */
export function resolveAgentCommand(config, role, explicit) {
    return explicit ?? config.roles?.[role] ?? config.agentCommand;
}
