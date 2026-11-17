# Bastion 棱堡 (`bastion-gate`)

**面向 AI 编程的测试锁定门禁与多 Agent 并行调度工具。**

[English](README.md) | **简体中文**

> 用 AI 写代码时常见一个头疼的问题：修不好 Bug，它干脆偷偷把测试改松、删掉断言，甚至改掉测试命令，然后告诉你“全部通过”。  
> **Bastion（棱堡）** 的做法是：**把测试和门禁锁在主分支上**，让多个 AI Agent 在各自隔离的分支里分批并发开发；不管开发过程怎么折腾，**没过门禁的代码绝不合入主线**。

- **不限工具与模型**：支持 Claude Code、Codex CLI、Cursor、Antigravity 或任意自定义脚本，**零运行时依赖**（需 Node.js >= 18、Git >= 2.5）
- **严格的测试门禁（`init` + `lock` + `gate` + `mutate`）**：
  - **先失败再锁定**：测试在动手前必须真实运行失败才准锁定，直接拒绝“永远通过”的无效测试，以及因为缺文件、语法错误导致的假失败；
  - **以主分支为准**：`gate` 只读取主分支上的配置和锁定清单，分支里偷偷修改测试文件或放宽测试命令都会被拦截；
  - **验收对照与测试强度抽查**：支持用 `.bastion/acceptance.md` 对照验收要点，并能在隔离环境中故意改坏几行源码（`mutate`），检验测试是否真的有效。
- **多 Agent 并行开发（`plan` + `run`，进阶）**：按任务依赖自动分批并发、独立工作区（`git worktree`）互不干扰、支持先装依赖再开工、失败后带报错自动重试、遇到测试本身有误时暂停交由人工确认（`.bastion/disputes/`），合并后连续多遍复检。
- **适用范围**：Bastion 保证 AI **没有偷偷修改验收标准**，但无法替人判断“验收标准本身是否合理”。建议花几分钟核对一遍测试清单，并尽量把“写测试”与“写实现”拆开到不同对话中完成。

---

## 快速上手（测试门禁）

```bash
# 1. 初始化配置、.gitignore、通用 Agent 规则与 GitHub Action 模板
npx bastion-gate init

# 2. 写好会失败的验收测试（或让 AI 先只写测试），连同配置提交到主分支
git add . && git commit -m "test: add failing acceptance tests"

# 3. 确认测试在主分支上确实失败后锁定（同时输出测试名称列表供快速核对）
npx bastion-gate lock
git add .bastion/lock.json && git commit -m "chore: lock baseline tests"

# 4. 在功能分支或 CI PR 中校验锁定文件未被修改，并亲自执行测试命令
npx bastion-gate gate
```

## 多 Agent 并行开发（`plan` + `run`）

> **费用与隔离说明**：`bastion run` 最多会调用 `节点数 × (maxRetries + 1)` 次 Agent，并自动汇总到一个独立的 `bastion/run-<时间>` 集成分支中，不会半途影响 `main`。如果你的测试依赖固定端口或共享数据库，建议从 `--concurrency 1` 起步。

```bash
# 1. 根据已锁定的测试自动生成 .bastion/plan.json 草稿并提交
npx bastion-gate plan --init
npx bastion-gate plan
git add .bastion/plan.json && git commit -m "chore: add execution plan"

# 2. 启动多工作区并发开发（建议通过 < {promptFile} 传递指令，避免跨平台引号问题）
npx bastion-gate run --setup "npm ci" --agent "claude -p --permission-mode acceptEdits --allowedTools \"Bash(node --test:*)\" < {promptFile}" --concurrency 4 --verify-runs 2
```

### 常见 Agent 接入写法（`--agent`）

| Agent 工具 | 推荐命令写法 |
|---|---|
| **Claude Code** | `claude -p --permission-mode acceptEdits --allowedTools "Bash(node --test:*)" < {promptFile}` *(Python 项目可改为 `Bash(pytest:*)`)* |
| **Codex CLI** | `codex exec - < {promptFile}` |
| **自定义脚本** | `node scripts/my-agent.mjs`（读取环境变量 `BASTION_PROMPT` 或 `BASTION_PROMPT_FILE`） |

> **安全提示**：尽量不要在未隔离的本机环境使用 `--dangerously-skip-permissions`；如确需全权限运行，建议放在容器或一次性沙盒中。

## 常用命令

- `bastion init [--test-cmd "<cmd>"] [--base <branch>] [--force]`：自动识别测试命令与当前分支，生成配置、CI 模板与通用 Agent 规范。
- `bastion lock [--base <ref>] [--amend --reason "<why>"] [--allow-dirty]`：先失败再锁定、拦截语法/导入假失败、打印测试名称列表并与 `.bastion/acceptance.md` 对照。
- `bastion gate [--base <ref>]`：从主分支读取配置与锁，校验锁定文件零改动并执行测试命令。
- `bastion plan [--init] [--force]`：生成或校验任务依赖与执行批次，检查需人工确认的高风险节点。
- `bastion run [--base <ref>] [--agent "<cmd>"] [--setup "<cmd>"] [--concurrency <n>] [--max-retries <n>] [--verify-runs <n>] [--timeout <min>] [--resume]`：多工作区并发调度、门禁反馈重试、过滤敏感临时文件及断点续跑。
- `bastion mutate [--max <n>] [files...]`：在隔离工作区中故意修改少量源码并跑测试，检查测试是否存在盲区。
- `bastion audit [--limit <n>]`：针对纯本地无 CI 仓库，核查历史合并提交是否绕过锁定范围。
- `bastion clean [--yes] [--runs]`：默认仅预览可清理的临时工作区和分支，加 `--yes` 后执行删除。

## 内置演练示例

仓库自带一个 5 模块的“个人记账报表”并发示例（4 个独立模块并发 + 1 个命令行汇总），可直接体验：

```bash
git clone https://github.com/maomuxz/bastion-gate.git
node bastion-gate/examples/setup-ledger.mjs ./ledger-test
```

## 开源协议

MIT（由 Claude 与 Antigravity 协作开发，并使用 Bastion 自身进行门禁验证）
