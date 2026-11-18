# 自举决定账本（手工模拟 v0.4 要做的 decisions 功能）

| # | 时间 | 档 | 决定 | 为什么 | 怎么撤回 |
|---|---|---|---|---|---|
| D1 | 2026-11-18 | 二 | 写回机制用小安的 outbox 方案 | AI 不碰主仓库、无并发写竞态 | 改回环境变量方案，重写 N3/N4 |
| D2 | 2026-11-18 | 二 | 退出码：1 失败 / 2 等待回答 / 3 预算用完 | 脚本能区分三种停法；1.0 前可改 | 改 run.ts 常量 + 测试 |
| D3 | 2026-11-18 | 二 | 命令名：summary / answer（用户），ask / decide（AI） | 用户和 AI 不共用一个词 | 改 cli.ts 分发与文档 |
| D4 | 2026-11-18 | 二 | 节点拆法取小克：手工空架子 + 6 块并发 | 最大并发、接口先锁 | 改成小安的 3 波拆法 |
| D5 | 2026-11-18 | 二 | 自举在 `dev/v0.4` 分支进行，main 不动；该分支上 `dist/` 不入库 | dist 被跟踪时，每块都会重新编译出 dist，并发合并必冲突；GitHub Action 读 main 上的 dist，所以 main 保持原样 | 发版时重新 build 并把 dist 加回跟踪，再合回 main |
| D6 | 2026-11-18 | 二 | 施工 AI 用 `scripts/dogfood-agent.mjs` 包一层 `claude -p`（sonnet，隔离用户级设置/MCP/技能），每次调用记一行 `.bastion/logs/usage.jsonl` | 只统计不设上限（mmxz 定）；隔离后量出来的才是 bastion 本身的开销，不混进个人配置 | 改 config.agentCommand；包装脚本已锁定，要改需 `lock --amend` |
| D7 | 2026-11-18 | 二 | 每块的 testCommand = 本块 v04 测试 + 原 12 条老测试 | 别的块的测试在本块里必然是红的；老测试防回归（尤其 N4 改 run.ts） | 改 plan.json 的 testCommand |
| D8 | 2026-11-18 | 二 | 把 run 结果合进 dev/v0.4；补强 summary 测试但不重锁 | 39/39 + 审计通过；补强测试是修我出题的盲区，lock --amend 现在要求先红做不到（F1） | revert 合并提交 b148e2f 与测试提交 |
| D9 | 2026-11-18 | 二 | 接受 p9-regress 的测试异议，修正测试后 lock --amend | 核实属实：测试对已删除目录调 realpathSync 必然抛错，正确实现永远过不了 | revert a77ea78 与 3152d83 |
| D10 | 2026-11-18 | 二 | 冒烟测试项目的地图由小克代为批准（出场②） | 一次性测试项目，可丢弃；真项目出场②必须 mmxz 本人 | 删掉 scratchpad/smoke |
