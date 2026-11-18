import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  CONFIG_REL_PATH,
  createDefaultConfig,
  writeConfigToDisk,
} from '../config.js';
import { execGit, getRepoRoot } from '../git.js';

export interface InitOptions {
  cwd: string;
  testCommand?: string;
  baseBranch?: string;
  force?: boolean;
}

const AGENTS_SNIPPET = `
<!-- bastion-gate:start -->
## Test Gate (Bastion)

- Tests and test-related configs/fixtures are locked by Bastion (\`.bastion/lock.json\`).
- **Do not** modify locked test files, test configs, fixtures, or \`.bastion/\` to make checks pass.
- If a locked test itself has a defect, stop and report it as \`test_defect\` for human confirmation.
- Before claiming work is done, run \`npx bastion-gate gate\` (or \`bastion gate\`).
<!-- bastion-gate:end -->
`;

const SKILL_MD = `---
name: bastion-gate
description: Enforce red-first test locking and immutable test gates with Bastion. Use before implementing features or claiming completion.
---

# Bastion Gate Workflow

1. **Red-first lock**: Write failing acceptance tests first, commit them to the baseline branch, and run \`bastion lock\` (must fail on baseline to be accepted).
2. **Implement without touching tests**: Write production code only. Never edit locked tests, test configs, fixtures, or \`.bastion/\`.
3. **Verify through the gate**: Run \`bastion gate\` before finishing. CI will re-run \`bastion gate\` against the baseline branch; local passes alone do not merge.
4. **Test defects**: If a locked test is genuinely wrong, stop and ask a human to confirm \`bastion lock --amend --reason "..."\`.
`;

function buildWorkflowYaml(repoRoot: string, baseBranch: string, setupCommand?: string): string {
  const setupSteps: string[] = [];

  if (fs.existsSync(path.join(repoRoot, 'package.json'))) {
    setupSteps.push(
      `      - uses: actions/setup-node@v4`,
      `        with:`,
      `          node-version: '20'`,
      `      - name: Install dependencies`,
      `        run: ${setupCommand ?? (fs.existsSync(path.join(repoRoot, 'package-lock.json')) ? 'npm ci' : 'npm install')}`
    );
  } else if (
    fs.existsSync(path.join(repoRoot, 'pyproject.toml')) ||
    fs.existsSync(path.join(repoRoot, 'requirements.txt'))
  ) {
    const pyInstall = setupCommand ?? (fs.existsSync(path.join(repoRoot, 'requirements.txt')) ? 'pip install -r requirements.txt' : 'pip install -e .');
    setupSteps.push(
      `      - uses: actions/setup-python@v5`,
      `        with:`,
      `          python-version: '3.12'`,
      `      - name: Install dependencies`,
      `        run: ${pyInstall}`
    );
  } else if (setupCommand) {
    setupSteps.push(`      - name: Setup`, `        run: ${setupCommand}`);
  }

  const setupBlock = setupSteps.length > 0 ? setupSteps.join('\n') + '\n' : '';
  return `name: Bastion Gate

on:
  pull_request:
    branches: [ ${baseBranch} ]

jobs:
  bastion-gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
${setupBlock}      - name: Run Bastion Gate
        uses: maomuxz/bastion-gate@v0
        with:
          base: "origin/\${{ github.base_ref }}"
`;
}

function detectTestCommand(repoRoot: string): string {
  const probes: Array<[string, string]> = [
    ['pyproject.toml', 'pytest'],
    ['pytest.ini', 'pytest'],
    ['go.mod', 'go test ./...'],
    ['Cargo.toml', 'cargo test'],
    ['pubspec.yaml', 'flutter test'],
  ];
  for (const [marker, cmd] of probes) {
    if (fs.existsSync(path.join(repoRoot, marker))) return cmd;
  }
  return 'npm test';
}

function detectBaseBranch(repoRoot: string): string {
  const res = execGit(['symbolic-ref', '--short', 'HEAD'], repoRoot);
  if (res.ok && res.stdout.trim()) return res.stdout.trim();
  return 'main';
}

function ensureGitignoreEntries(repoRoot: string): void {
  const gitignorePath = path.join(repoRoot, '.gitignore');
  const entries = [
    '.bastion/worktrees/',
    '.bastion/logs/',
    '.bastion/receipts/',
    '.bastion/run-state.json',
    '.bastion/run.pid',
    '.bastion/outbox/',
    '.bastion/decisions.json',
    '.bastion/inbox.json',
    '.bastion/maps/',
    '.bastion/map-diff.md',
    '.bastion/brief.md',
    '.bastion/approval.json',
    '.bastion/qa.json',
    '.bastion/qa-disputes.md',
    '.bastion/feedback/',
    '.bastion/flow-state.json',
    '.bastion/requirement.md',
  ];
  const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
  const missing = entries.filter((e) => !existing.includes(e));
  if (missing.length === 0) return;

  const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(gitignorePath, existing + prefix + missing.join('\n') + '\n', 'utf8');
  console.log(`[bastion] Updated .gitignore (${missing.join(', ')})`);
}

export function runInit(opts: InitOptions): number {
  const repoRoot = getRepoRoot(opts.cwd) ?? path.resolve(opts.cwd);
  const configPath = path.join(repoRoot, CONFIG_REL_PATH);

  const resolvedBase = opts.baseBranch ?? detectBaseBranch(repoRoot);
  const resolvedTestCmd = opts.testCommand ?? detectTestCommand(repoRoot);

  if (fs.existsSync(configPath) && !opts.force) {
    console.log(`[bastion] ${CONFIG_REL_PATH} already exists (use --force to overwrite).`);
  } else {
    const config = createDefaultConfig({
      testCommand: resolvedTestCmd,
      baseBranch: resolvedBase,
    });
    writeConfigToDisk(repoRoot, config);
    console.log(`[bastion] Created ${CONFIG_REL_PATH}`);
  }

  ensureGitignoreEntries(repoRoot);

  // Write or append AGENTS.md
  const agentsPath = path.join(repoRoot, 'AGENTS.md');
  if (!fs.existsSync(agentsPath)) {
    fs.writeFileSync(agentsPath, AGENTS_SNIPPET.trimStart(), 'utf8');
    console.log('[bastion] Created AGENTS.md');
  } else {
    const existing = fs.readFileSync(agentsPath, 'utf8');
    if (!existing.includes('<!-- bastion-gate:start -->')) {
      fs.writeFileSync(agentsPath, existing.trimEnd() + '\n\n' + AGENTS_SNIPPET.trimStart(), 'utf8');
      console.log('[bastion] Appended Bastion section to AGENTS.md');
    } else {
      console.log('[bastion] AGENTS.md already contains Bastion section.');
    }
  }

  // Write universal SKILL.md
  const skillPath = path.join(repoRoot, '.agents', 'skills', 'bastion-gate', 'SKILL.md');
  if (!fs.existsSync(skillPath) || opts.force) {
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.writeFileSync(skillPath, SKILL_MD, 'utf8');
    console.log('[bastion] Created .agents/skills/bastion-gate/SKILL.md');
  }

  // Write GitHub Action workflow template
  const workflowPath = path.join(repoRoot, '.github', 'workflows', 'bastion.yml');
  if (!fs.existsSync(workflowPath) || opts.force) {
    fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
    fs.writeFileSync(workflowPath, buildWorkflowYaml(repoRoot, resolvedBase), 'utf8');
    console.log('[bastion] Created .github/workflows/bastion.yml');
  }

  console.log('\nNext steps:');
  console.log('  1. Commit .bastion/config.json, tests, and .github/workflows/bastion.yml to your baseline branch.');
  console.log('  2. Run "bastion lock" while tests are RED on the baseline.');
  console.log('  3. Commit .bastion/lock.json and enable branch protection requiring the Bastion Gate CI check.');
  return 0;
}
