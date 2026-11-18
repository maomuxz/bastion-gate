# Bastion v0.4 项目地图（白纸重做版 · 小安）

> 定位：独立于设计师方案的盲写地图，仅基于需求与当前 `v0.3.0` 源码接口设计。

---

## 一、接口约定

### 1.1 `.bastion/config.json` 新增字段（`src/config.ts`）

```ts
export interface BastionRoles {
  planner?: string;
  tester?: string;
  worker?: string;
  qa?: string;
}

export interface BastionBudget {
  maxAgentCalls?: number;   // 最多调用 AI 次数（含重试）
  maxTotalMinutes?: number; // 最多累计运行分钟数
}

// BastionConfig 新增可选字段：
// roles?: BastionRoles;
// checks?: string[];        // gate 前置检查命令（如 "npx tsc --noEmit", "npm run lint"）
// budget?: BastionBudget;
```

- **岗位回退规则**：v0.4 `run` 调度施工时取 `config.roles?.worker ?? opts.agentCommand ?? config.agentCommand`（若传了 `--agent` 则 CLI 显式覆盖优先，或 `--role-worker` 可选）。其余 `planner` / `tester` / `qa` 本版先保留配置槽位与解析校验，暂不启用。
- **`checks` 顺序语义**：`gate` 通过锁定范围完整性校验后，先依次执行 `baseConfig.checks`（从基线 ref 读取！防 PR 分支篡改），任一检查非 0 退出立即 `GATE FAIL` 并附末尾 40 行输出；全部通过后再执行 `testCommand`。

### 1.2 新增状态文件（均不提交到业务分支，由主进程维护）

1. **`.bastion/decisions.json`（二档决定账本）**：
   ```ts
   export interface DecisionRecord {
     id: string;        // 如 "dec-001"
     nodeId: string;
     what: string;      // 做了什么
     why: string;       // 为什么选这个方案
     rollback: string;  // 怎么撤回（如命令或改动文件说明）
     createdAt: string;
   }
   ```
2. **`.bastion/inbox.json`（三档待办队列）**：
   ```ts
   export interface Tier3Question {
     id: string;        // 如 "q-001"
     nodeId: string;
     question: string;
     recommended?: string;
     options?: string[];
     status: 'pending' | 'answered';
     answer?: string;
     createdAt: string;
     answeredAt?: string;
   }
   ```
3. **`.bastion/run-state.json` 扩展字段**：
   ```ts
   // 在现有 integrationBranch, baseRef, completedNodes 基础上新增：
   blockedNodes: string[];          // 因三档待办暂停的节点 id
   agentCallsUsed: number;          // 已消耗 AI 调用次数
   accumulatedMinutes: number;      // 历次运行累计耗时（用于 --resume 续算预算）
   budgetExhausted?: 'calls' | 'minutes';
   ```

### 1.3 施工 AI 在 Worktree 中如何把账本/问题写回主仓库

因为工作区位于临时 worktree 且 `.bastion/` 被 `BLOCKED_COMMIT_PATTERN` 禁止提交，禁止让 AI 直接写主仓库文件，采用 **Outbox 交接约定**：
- AI 在自己 worktree 内写入单节点专属文件（互不冲突）：
  - 二档决定：`.bastion/outbox/<nodeId>.decisions.json`（`Array<{ what, why, rollback }>`）
  - 三档问题：`.bastion/outbox/<nodeId>.tier3.json`（`Array<{ question, recommended?, options? }>`）
- **`run.ts` 主进程挂点**（在 `runGateAsync` 之前或之后、清理 worktree 之前）：
  1. **每次调用 Agent 前**：检查 `agentCallsUsed >= maxCalls` 或累计耗时 `>= maxMinutes` → 触顶保存 `run-state.json` 后体面退出（提示加预算 `--resume`）。
  2. **每次 Agent 退出后**：
     - 读取 worktree 内的 `.bastion/outbox/<nodeId>.decisions.json`，原子追加到主仓库 `.bastion/decisions.json`（注意 `gate` 放行 `.bastion/outbox/` 下的文件，不将其判为篡改基线配置！）。
     - 读取 worktree 内的 `.bastion/outbox/<nodeId>.tier3.json`：若存在待提问，将其追加到主仓库 `.bastion/inbox.json`（`status: 'pending'`），把该节点记入 `blockedNodes`，**立刻暂停该节点（不重试、不合并）**，继续跑其他未受阻塞的节点。
  3. **注入已回答的三档批复**：当用户通过 `bastion ask` 回答后再次 `bastion run --resume`，将该节点在 `inbox.json` 中的 `answer` 拼接到 `BASTION_PROMPT` / `promptFile` 末尾再重启该节点。
  4. **动态就绪调度**：将 `run.ts` 原先“整波同步等全绿”的 `for (wave)` 循环，改为基于依赖图的**就绪队列（Ready Queue）**：只要一个节点的所有 `dependsOn` 都已进 `completedNodes`，即可在并发槽位内发射；某个节点进 `blockedNodes` 只阻塞直接或间接依赖它的下游节点，不卡住无关节点。

### 1.4 新命令形态（`src/cli.ts`）

- `bastion decisions [--json]`：一屏列出所有二档决定（做了什么 / 为什么 / 怎么撤回）。
- `bastion ask [--answer <id>=<text>]`：交互式逐条回答 `pending` 三档问题；传入 `--answer` 时非交互批复（方便脚本和自动化测试），全部回答后提示可执行 `bastion run --resume`。
- `bastion summary [--json]`：输出“你不在时”三行报告：
  1. `已完成：<completed>/<total> 块`
  2. `替你定了：<decisionsCount> 件（运行 bastion decisions 查看）`
  3. `等你拍板：<pendingCount> 件（运行 bastion ask 批复）`
- `bastion run` 新增参数：`--max-calls <n>`、`--max-minutes <n>`（覆盖 `config.budget`，加预算续跑时直接传更大值配合 `--resume`）。

---

## 二、节点拆分与防冲突波次规划

为避免多节点并发修改同一文件（特别是 `src/config.ts`、`src/cli.ts`），拆分为 **3 个波次、5 个节点**：

| 波次 | 节点 ID | 独占修改/新建文件 | 依赖 | 白话验收句 |
|---|---|---|---|---|
| **Wave 1** | `v04-schema` | `src/config.ts`、`src/commands/init.ts`、`.gitignore` | 无 | `config.json` 支持 `roles`、`checks`、`budget`；提供 `decisions.json`、`inbox.json`、`run-state.json` 的读写工具；`init` 与 `.gitignore` 自动忽略新状态文件与 `.bastion/outbox/`。 |
| **Wave 2（并发）** | `v04-gate-checks` | `src/commands/gate.ts` | `v04-schema` | `gate` 读取基线 `checks` 数组并先于 `testCommand` 顺序执行，任一前置检查失败即返回非 0 并把末尾输出写入 `feedback`。 |
| **Wave 2（并发）** | `v04-ledger-cmds` | `src/commands/decisions.ts`、`src/commands/ask.ts`、`src/commands/summary.ts` | `v04-schema` | `decisions` 清晰列出二档记录；`ask` 支持交互与 `--answer` 批复三档待办；`summary` 输出精确的“已完成 / 替你定了 / 等你拍板”三行报告。 |
| **Wave 2（并发）** | `v04-run-engine` | `src/commands/run.ts` | `v04-schema` | `run` 优先使用 `roles.worker`；收集 `outbox` 二档决定与三档待办；三档只停单节点、其余无依赖节点照跑；触及 `maxCalls` / `maxMinutes` 体面保存进度停机并支持加预算 `--resume`。 |
| **Wave 3** | `v04-cli-wire` | `src/cli.ts`、`README.md`、`README.zh-CN.md` | `v04-gate-checks`, `v04-ledger-cmds`, `v04-run-engine` | CLI 注册 `decisions`、`ask`、`summary` 及 `run` 预算参数；帮助信息与文档同步更新；全量自测通过。 |

*(注：若在自举施工时，测试文件 `tests/*.test.ts` 由各自对应节点只追加各自独立的 `tests/v04-*.test.ts` 文件并提前在基线锁定，也可完全避免多个节点抢改同一个 `tests/bastion.test.ts`。)*

---

## 三、最容易出错、最容易返工的地方

1. **`gate` 误把 `.bastion/outbox/` 判成非法篡改**：
   - `gate.ts` 若检查 `.bastion/` 脏文件或匹配通配符，必须显式放行 `.bastion/outbox/`、`.bastion/logs/`、`.bastion/run-state.json` 等运行时产物，否则节点写了二档决定或三档问题反而会被 `gate` 拦截！
2. **动态调度与现行 `for (wave)` 的兼容**：
   - `dag.ts` 目前返回静态波次二维数组。若节点 A 在 Wave 1 因三档停下，原先 `run.ts` 会在 Wave 1 结尾直接 `return 1`，导致 Wave 2 中只依赖节点 B 的节点 C 被误卡死。必须改成按每个节点的 `dependsOn` 动态判断是否可运行，且在循环结束后区分“有未解决的三档待办（退出码 2 或 1 并明确提示 `bastion ask`）”与“硬失败”。
3. **跨 worktree 并发追加 `decisions.json` / `inbox.json` 的竞态**：
   - 异步并发多个 worktree 同时完成并往主仓库同一个 JSON 写数据时，虽然 JS 单线程事件循环里同步 `readFileSync` + `writeFileSync` 不会丢数据，但**切忌把 read 和 write 拆在 `await` 两侧**——必须封装成同步的原子追加函数。
4. **`--resume` 续跑时的预算重置逻辑**：
   - 如果配置里写死 `maxAgentCalls: 10`，跑满 10 次停下后，用户若不改 `config.json` 而只传 `--max-calls 20 --resume`，`run.ts` 必须拿 `20` 与累计已用 `agentCallsUsed` 比较，且不能因为基线分支 `config.json` 还是 `10` 而覆盖掉用户新传的 `--max-calls`。

---

## 四、哪些事属于第三档，需要停下来问 mmxz

1. **是否允许修改现行 `v0.3.0` 已锁定的 `tests/bastion.test.ts` 或 `package.json`（比如升级版本号到 `0.4.0`）**：涉及修改基线锁定范围与发版节奏，须由 mmxz 拍板。
2. **对外发布动作（`npm publish`、`git push`、公开推广）**：撤不回且对外可见，必须等 mmxz 确认。
3. **`bastion ask` 与 `gate` 遇到三档阻塞时的退出码约定**（例如：普通失败退出码 `1`，因三档挂起或预算耗尽暂停是否约定专用退出码如 `2` 以便区分脚本自动化）：若影响外部脚本契约，需确认后再定。
4. **实际自举施工时是否启用真实付费模型跑 `bastion run`**：会真实消耗 token/额度，开跑前需 mmxz 确认预算上限。
