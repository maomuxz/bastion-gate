# bastion v0.4 合并地图（设计师 小克 × 白纸重做 小安，2026-11-18）

## 分歧与裁决（这一节本身就是"白纸重做"的产物）

| # | 分歧 | 小克 | 小安 | 裁决 | 理由 |
|---|---|---|---|---|---|
| 1 | 施工 AI 怎么写回账本/问题 | 环境变量 BASTION_HOME，AI 直接写主仓库 | AI 只写自己 worktree 的 `.bastion/outbox/<节点>.*.json`，主进程收集 | **取小安** | AI 不碰主仓库、没有并发写竞态；`bastion decide/ask` 在节点里运行时就写 outbox |
| 2 | 调度方式 | 只加挂点 | 一波失败就整体退出 → 必须改成就绪队列 | **取小安（小克漏了）** | 不改的话"只停一块"根本做不到 |
| 3 | gate 会不会误拦 outbox | 没想到 | 必须放行 `.bastion/outbox/` 等运行产物 | **取小安**，写成测试 | |
| 4 | 续跑时加预算 | 只读 config | `--max-calls/--max-minutes` 覆盖 config，和已用量比较 | **取小安** | 用户加预算不必改锁定的配置 |
| 5 | 节点拆法 | 小克手工搭空架子，6 块全并发 | AI 做 schema → 3 块并发 → 最后接 CLI | **取小克** | 空架子是设计工作，手工做更稳；之后最大并发 |
| 6 | 命令名 | `status --away` / `answer <id>` | `summary` / `ask --answer` | **合并**：用户看三行 `bastion summary`，用户回答 `bastion answer <id> "<答复>"`；AI 在节点里提问 `bastion ask`、记决定 `bastion decide` | "ask" 留给 AI 提问，避免用户和 AI 用同一个词 |
| 7 | 退出码 | 预算停 = 3 | 认为是三档 | **二档按推荐定**：1 失败 / 2 等待回答 / 3 预算用完；记进决定账本 | 1.0 前可改，撤得回 |

## 最终节点

| 节点 | 谁做 | 文件 | 白话验收句 |
|---|---|---|---|
| N0 空架子 | 小克手工 | config.ts 类型；src/{roles,checks,ledger,inbox,budget,summary,outbox}.ts 空函数；cli.ts 命令分发；.gitignore | 原 12 条测试全过；新命令能识别（未实现时报"未实现"） |
| N1 岗位槽位 | bastion run | src/roles.ts | 配了 roles.worker 就用它；`--agent` 显式传入时优先；都没有就用 agentCommand |
| N2 前置检查 | bastion run | src/checks.ts + gate 调用 | gate 从**基线**读 checks 先跑，任一失败 GATE FAIL 并指出哪条；`.bastion/outbox/` 等运行产物不算篡改 |
| N3 决定账本 | bastion run | src/ledger.ts + decide/decisions | 节点里 `bastion decide` 写进 outbox，跑完汇总进主仓库 decisions.json；`bastion decisions` 按时间列出（做了什么/为什么/怎么撤回） |
| N4 三档 + 就绪队列 | bastion run | src/inbox.ts + run.ts 调度 | 某块 `bastion ask` 后只停它和依赖它的块，其余照跑，退出码 2；`bastion answer` 后 `--resume` 只重跑它并把答复带进提示 |
| N5 预算闸 | bastion run | src/budget.ts | 次数或分钟到上限就保存进度、退出码 3；`--max-calls/--max-minutes` 加大后 `--resume` 接着算 |
| N6 三行 | bastion run | src/summary.ts | `bastion summary` 打印：做完几块 / 替你定了几件 / 几件等你拍板 |

N4 改 run.ts 的调度循环；N3/N5 的挂点在 N0 里写好调用位置，函数在各自文件里，避免和 N4 抢 run.ts。

## 第三档（要问 mmxz）
1. 真跑 `bastion run` 用真模型 → 预算上限
2. 发版时把 package.json 版本改成 0.4.0（package.json 在锁定范围里，要正式修改锁）→ 发版那一步再问
3. push / npm publish → 发版那一步再问
