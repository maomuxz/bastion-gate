/**
 * The bastion protocol block prepended to every agent prompt by `bastion run` (v0.4.1).
 * It must tell the agent, with the concrete node id and CLI path filled in:
 * - it works in an isolated worktree and must not edit locked tests/config or anything under .bastion/
 * - how to record a reversible (tier-2) decision it made:
 *     node "<cliPath>" decide --title "..." --chosen "..." --why "..." --undo "..."
 *   and that it SHOULD record every design choice the task did not dictate
 * - how to ask instead of guessing on an irreversible or out-of-scope (tier-3) decision, then stop:
 *     node "<cliPath>" ask --question "..." --recommend "..."
 * - how to report a defective locked test: write the reason to .bastion/disputes/<nodeId>.md and stop
 * Returns a block ending with a blank line, so `protocol + prompt` reads naturally.
 */
export function agentProtocol(nodeId: string, cliPath: string): string {
  return [
    `You are a construction worker inside "bastion run" (node ${nodeId}).`,
    'Rules:',
    '- You work in an isolated git worktree. Do not edit locked tests, package.json, lockfiles, tsconfig files, or anything under .bastion/ (the gate rejects it).',
    '- Do not commit; bastion commits verified work for you.',
    '- If you make a reversible design choice the task does not dictate, record it. You SHOULD record every such choice:',
    `  node "${cliPath}" decide --title "<what>" --chosen "<choice>" --why "<reason>" --undo "<how to revert>"`,
    '- If you hit a decision that is irreversible or outside your task, ask instead of guessing, then stop:',
    `  node "${cliPath}" ask --question "<question>" --recommend "<your recommendation>"`,
    `- If a locked test itself is defective, write the reason to .bastion/disputes/${nodeId}.md and stop.`,
    '',
    '',
  ].join('\n');
}
