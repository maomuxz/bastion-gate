# Bastion 棱堡 (`bastion-gate`)

**专为 AI 编程设计的“先红后锁”测试门禁 + 多 Agent 并行调度引擎。**

[English](README.md) | **简体中文**

> 你是不是也遇到过：AI 修不好 Bug，干脆偷偷把你的单元测试改松、删断言，或者把测试命令改成 `exit 0`，然后转身跟你说“测试全绿了”？  
> **Bastion（棱堡）** 的思路很简单：城外是**不可绕过的测试锁定与 CI 基线门禁**，城里可以让多个 AI Agent 在各自隔离的 `git worktree` 中按依赖波次**并发施工**——不管城里怎么折腾，**没过门禁绝不进主线**。

- **不挑工具、不绑模型**：支持 Claude Code、Codex CLI、Cursor、Antigravity 或任意自定义脚本，**零运行时依赖**（Node.js >= 18、Git >= 2.5）
- **硬测试门禁（`init` + `lock` + `gate` + `mutate`）**：
  - **先红后锁 + 防假红**：测试在基线上必须真实失败在断言上才准锁，直接拒收 `assert true` 放水测试和缺模块/语法报错的“假红”；
  - **基线配置裁决**：`gate` 从主分支基线读取 `.bastion/config.json` 与 `.bastion/lock.json`，PR 分支偷改测试或配置一律拦截；
  - **白话清单对照 + 变异抽查**：支持 `.bastion/acceptance.md` 白话验收对照，并在隔离 worktree 中做轻量变异抽查（`mutate`）。
- **多 Agent 并行调度（`plan` + `run`，进阶）**：拓扑波次编排、独立 `git worktree` 隔离、`setupCommand` 装依赖、带失败反馈自动重试、`.bastion/disputes/<nodeId>.md` 争议暂停通道，以及合入后连续 N 遍全量复检。
- **适用边界**：Bastion 保证 AI **没偷偷挪球门**，但不能保证“球门一开始就放对了地方”——建议由人花 5 分钟审一遍白话验收清单，并将“写测试”与“写实现”拆开到不同会话。

---

## 快速上手（测试门禁）

```bash
# 1. 初始化 .bastion/config.json、.gitignore、AGENTS.md、SKILL.md 与 GitHub Action
npx bastion-gate init

# 2. 写好会失败的验收测试（或让 AI 先只写测试），连同配置提交到基线分支
git add . && git commit -m "test: add failing acceptance tests"

# 3. 验证测试在基线上确实为红并锁定（同时打印白话测试名清单供扫一眼）
npx bastion-gate lock
git add .bastion/lock.json && git commit -m "chore: lock baseline tests"

# 4. 在功能分支或 CI PR 中校验锁定范围并执行基线测试命令
npx bastion-gate gate
```

## 多 Agent 并行开发（`plan` + `run`）

> **费用与隔离提示**：`bastion run` 最多会调用 `节点数 × (maxRetries + 1)` 次 Agent，并自动合并到独立的 `bastion/run-<时间>` 集成分支，不会半途污染 `main`。如果测试会抢占固定端口或同一数据库，请从 `--concurrency 1` 起步。

```bash
# 1. 根据已锁定的测试自动生成 .bastion/plan.json 草稿并提交
npx bastion-gate plan --init
npx bastion-gate plan
git add .bastion/plan.json && git commit -m "chore: add execution plan"

# 2. 启动多 worktree 并发施工（推荐使用 < {promptFile} 或环境变量避免跨平台引号截断）
npx bastion-gate run --setup "npm ci" --agent "claude -p --permission-mode acceptEdits --allowedTools \"Bash(node --test:*)\" < {promptFile}" --concurrency 4 --verify-runs 2
```

### 常见 Agent 接入写法（`--agent`）

| Agent CLI | 推荐命令写法 |
|---|---|
| **Claude Code** | `claude -p --permission-mode acceptEdits --allowedTools "Bash(node --test:*)" < {promptFile}` *(Python 项目可改为 `Bash(pytest:*)`)* |
| **Codex CLI** | `codex exec - < {promptFile}` |
| **自定义脚本** | `node scripts/my-agent.mjs`（直接读取环境变量 `BASTION_PROMPT` 或 `BASTION_PROMPT_FILE`） |

> **安全提示**：切勿随意在未隔离的本机环境使用 `--dangerously-skip-permissions`；如确需全权限运行，请放在容器或一次性沙盒中。

## 常用命令一览

- `bastion init [--test-cmd "<cmd>"] [--base <branch>] [--force]`：自动探测测试命令与当前分支，生成配置、Action 工作流与通用 Agent 规范。
- `bastion lock [--base <ref>] [--amend --reason "<why>"] [--allow-dirty]`：先红后锁、防假红校验、输出白话测试清单与 `.bastion/acceptance.md` 对照。
- `bastion gate [--base <ref>]`：从基线分支读取配置与锁，校验锁定范围零改动并亲自执行测试命令。
- `bastion plan [--init] [--force]`：自动生成或校验 DAG 并行波次计划与三档审批卡点。
- `bastion run [--base <ref>] [--agent "<cmd>"] [--setup "<cmd>"] [--concurrency <n>] [--max-retries <n>] [--verify-runs <n>] [--timeout <min>] [--resume]`：多 worktree 并发调度、门禁反馈重试、安全提交过滤与断点续跑。
- `bastion mutate [--max <n>] [files...]`：在隔离 worktree 中抽样变异源码，检验测试是否漏测。
- `bastion audit [--limit <n>]`：针对纯本地无 CI 仓库，审计历史合并提交是否绕过锁定范围。
- `bastion clean [--yes] [--runs]`：默认 dry-run 预览残留 worktree 与临时分支，加 `--yes` 清理。

## 内置靶子示例

仓库自带一个 5 节点“个人记账报表”并发靶子（`csv` / `category` / `money` / `stats` 4 路并发 + `cli` 汇总），可一键体验：

```bash
git clone https://github.com/maomuxz/bastion-gate.git
node bastion-gate/examples/setup-ledger.mjs ./ledger-test
```

## 开源协议

MIT（由 Claude 与 Antigravity 协作构建，并由 Bastion 自举把关）
