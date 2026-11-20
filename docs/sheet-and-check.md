# `bastion sheet` 与 `bastion check` 用法说明

这两个命令用于“代码库公开接口速查 + 编译器与锁定硬规矩把关”的轻量工作流，不需要先跑地图拆分或多工作区并发，可单独在任意项目中使用。

---

## 一、`bastion sheet`：从源码生成公开接口速查表

扫描项目公开入口代码，自动生成紧凑的接口签名与工程硬规则速查表（当前支持 Dart）。源码改动后重新运行即可更新，也可在 CI 中用 `--check` 检查速查表是否过期。

### 1. 配置文件（`.bastion/sheet.json`）

默认读取仓库根目录下的 `.bastion/sheet.json`（也可放在 `.bastion/config.json` 的 `"sheet"` 字段中，或通过 `--config <path>` 指定）：

```json
{
  "language": "dart",
  "output": ".bastion/sheet.md",
  "title": "Acme Kit 公开接口与规则速查表",
  "ruleFiles": ["checks/check_rules.dart"],
  "notes": [
    "分层约定：`lib/core/` 纯无界面逻辑层；`lib/features/` 通过 `package:acme_kit/ui/ui.dart` 使用统一组件。"
  ],
  "entries": [
    "lib/app/run_mode.dart",
    {
      "path": "lib/ui/ui.dart",
      "title": "统一组件库（`import 'package:acme_kit/ui/ui.dart';`）",
      "exportPrefixes": ["tokens/", "base/", "shell/"],
      "discoverUnexportedDirs": ["shell"]
    }
  ]
}
```

字段说明：
- `language`：必填，当前仅支持 `"dart"`。
- `output`：输出 Markdown 路径（默认 `.bastion/sheet.md`）。
- `ruleFiles`：可选，自动提取检查脚本文件头部形如 `// 1. ...` 的硬规则注释。
- `notes`：可选，补充单行分层或工程约定。
- `entries`：必填，按顺序扫描的入口文件或目录列表：
  - 若文件内含 `export '...'`（桶文件），会自动按导出顺序递归提取公开 `enum`、`typedef`、`class`（含主构造、公开命名构造、`static` 成员与 `ThemeExtension` 字段）及顶层函数，并遵守 `show` / `hide` 过滤。
  - 无公开构造函数的纯静态工具类（如 `abstract final class AcmeToast`）会显式保留 `abstract final class` 与 `static` 标记，防止模型误写成实例调用。
  - `discoverUnexportedDirs`：可选，自动扫描桶文件同级子目录中未被重导出的公开 `.dart` 文件，并单独标注其独立 `import` 路径。

### 2. 常用命令

```bash
# 生成或更新速查表
bastion sheet

# 指定配置文件与输出位置
bastion sheet --config .bastion/sheet.json --out docs/api-sheet.md

# 检查磁盘上的速查表是否与当前源码一致（不一致退出码为 1）
bastion sheet --check
```

---

## 二、`bastion check`：编译检查 + 锁定硬规矩把关

对改动文件依次执行**锁定文件防篡改校验**、**项目自有编译检查**与**项目硬规矩检查**。未通过时仅输出“文件路径:行号 [规则号] 违规事实”的裸报告（自动剥除 `Try ...`、`请改用 ...` 等改法提示），可配合 `--agent` 自动执行最多 **2 轮**打回重写。

### 1. 配置文件（`.bastion/check.json`）

默认读取 `.bastion/check.json`（也可写在 `.bastion/config.json` 的 `"check"` 字段中，或通过 `--config <path>` 指定）：

```json
{
  "cwd": ".",
  "compile": {
    "name": "compile",
    "command": "dart analyze --format=machine {files}"
  },
  "rules": [
    {
      "name": "UI_RULE",
      "command": "dart run checks/check_rules.dart"
    }
  ],
  "lockedFiles": [
    "checks/check_rules.dart",
    "analysis_options.yaml"
  ],
  "maxRetries": 2,
  "timeoutSeconds": 90
}
```

字段说明：
- `compile`：必填，编译检查命令（字符串、对象或数组）。支持 `{files}` 占位符自动展开为传入的目标文件列表。
- `rules`：可选，项目硬规矩检查命令列表；省略时自动复用 `.bastion/config.json` 中的 `checks`。
- `lockedFiles`：可选，受保护的规则脚本或配置文件路径/通配符。运行 `bastion check --lock` 后会将内容哈希写入 `.bastion/check-lock.json`；若仓库同时存在 `bastion lock` 生成的 `.bastion/lock.json`，两份锁会一并校验。
- `maxRetries`：配合 `--agent` 打回重写时的最大轮数，取值范围 `0..2`（默认 `2`，硬上限 `2` 轮）。

### 2. 常用命令

```bash
# 锁定规则脚本与检查配置（生成 .bastion/check-lock.json）
bastion check --lock

# 对指定改动文件执行单次把关（通过退出码 0，违规退出码 1 并打印裸报告）
bastion check lib/features/export_panel.dart

# 输出结构化 JSON 报告（便于外部脚本集成）
bastion check --json lib/features/export_panel.dart

# 未过门禁时把裸报告喂给施工命令自动重写（最多打回 2 轮；若篡改锁定文件立即中止）
bastion check --agent "node scripts/worker.mjs" --max-retries 2 lib/features/export_panel.dart
```
