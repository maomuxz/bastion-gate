# bastion v0.4 地图（设计师：小克，2026-11-18）

需求（mmxz 出场①已确认）：roles 岗位槽位 / 二档决定账本 / 三档排队只停该节点 / status --away 三行 / 预算闸（次数+分钟）/ gate 前置 checks。
不做：map、review、按金额预算、全机限流。

## 接口约定（N0 空架子里先写死，之后各节点不许改签名）

### config.json 新增（全部可选）
```jsonc
{
  "roles": { "planner": "<cmd>", "tester": "<cmd>", "worker": "<cmd>", "qa": "<cmd>" }, // 缺省回退 agentCommand
  "checks": ["npx tsc --noEmit"],              // gate 先按顺序跑，任一非 0 → GATE FAIL
  "budget": { "maxAgentCalls": 20, "maxMinutes": 120 }
}
```

### 新文件（都在主仓库 `.bastion/` 下，gitignore）
- `decisions.json`：`[{ id, at, tier: 2, node?, title, chosen, why, undo }]`
- `inbox.json`：`[{ id, at, node, question, recommend, status: "open"|"answered", answer?, answeredAt? }]`
- `run-state.json` 增字段：`agentCalls, startedAt, elapsedMs, blockedNodes: string[], budgetHit?: "calls"|"minutes"`
- `status-seen.json`：`{ lastSeenAt }`（status --away 用来算"你不在时"）

### 给施工 AI 的环境变量
- `BASTION_HOME` = 主仓库根目录（AI 在 worktree 里调 `bastion decide/ask` 时写回主仓库账本）
- `BASTION_NODE_ID`（已有）

### 新命令
- `bastion decide --title "<t>" --chosen "<c>" --why "<w>" [--undo "<u>"] [--node <id>]`
- `bastion decisions [--since <iso>]`
- `bastion ask --node <id> --question "<q>" --recommend "<r>"`
- `bastion answer <inboxId> "<answer>"`
- `bastion status --away`

### run.ts 挂点（N0 写好调用，函数体留空，节点只填模块）
- 派发每次 agent 前：`budget.check(state, config)` → 超限则保存状态、打印"加预算后 --resume"、退出码 3
- 每次 agent 调用后：`budget.record(state)`
- 开跑节点前：`inbox.hasOpen(home, nodeId)` → 有则记入 blockedNodes、跳过，其余节点继续
- agent 尝试结束后：若该节点在本轮新写了 inbox 问题 → 不重试，标记 blocked
- `--resume`：已答复的节点把答复拼进 prompt 再跑
- 选 agent 命令：`roles.resolve(config, "worker")`

## 节点（N0 由小克手工做；N1–N6 交 bastion run 并发施工）

| 节点 | 文件 | 依赖 | 白话验收句 |
|---|---|---|---|
| N0 空架子 | config.ts 类型、src/{roles,checks,ledger,inbox,budget,status}.ts 空函数、cli.ts 命令分发、run.ts 挂点 | — | 现有 12 条测试仍全过；新命令都能被识别（未实现时报"未实现"） |
| N1 roles | src/roles.ts | N0 | 配了 roles.worker 就用它，没配就用 agentCommand；planner/tester/qa 能读出来 |
| N2 checks | src/checks.ts + gate 调用 | N0 | gate 先跑 checks（从基线配置读），任一失败就 GATE FAIL 并说是哪条；都过才跑测试 |
| N3 账本 | src/ledger.ts + decide/decisions | N0 | AI 在 worktree 里 decide，主仓库 decisions.json 多一条；decisions 能按时间列出、带撤回方法 |
| N4 三档 | src/inbox.ts + ask/answer + run 挂点逻辑 | N0 | AI ask 后该节点停下、其他节点照跑；answer 后 --resume 只重跑它，答复带进 prompt |
| N5 预算 | src/budget.ts | N0 | 调用次数或分钟到上限就停、保存进度、退出码 3；改大预算后 --resume 接着跑 |
| N6 三行 | src/status.ts + status --away | N0 | 打印三行：做完几块 / 替你定了几件（带标题）/ 几件等你拍板；看过后更新 lastSeenAt |

波次：W0 = N0（手工）；W1 = N1–N6 全并发（接口已锁，各写各的文件）。
三档（停下问 mmxz）：push 到 GitHub、npm 发布、改锁定范围。

## 测试（出题 = 先写会失败的测试再 lock）
每节点一个 `tests/v04-<节点>.test.ts`，在 N0 之后、施工之前写好，`bastion lock` 锁住（先红后锁会验证它们在基线上确实失败）。
