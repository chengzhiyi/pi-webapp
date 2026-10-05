# 用 Sentry CLI + Codex 分析已有问题

在仓库根目录运行。流程读取 Sentry 的 Issue 和多个事件样本，让 Codex 对照本地源码分析，生成中文 Markdown 和结构化 JSON 报告。它不修改应用代码或 Sentry 问题状态，也不调用 Seer。

## 首次准备

```sh
npm install -g sentry
sentry auth login --read-only
sentry auth status
codex login status
```

需要官方 `sentry` CLI（不是旧的 `sentry-cli` 命令）和已登录的 Codex CLI。账号须能读取目标组织和项目。OAuth 凭据由 CLI 保存，不写入仓库。Codex 使用用户现有的模型和登录配置；分析会消耗正常 Codex 使用额度。

## 运行

```sh
# 最近 7 天仍未解决的问题：最多 20 个，每个最多读取 3 个事件
npm run sentry:triage

# 调整范围。按发生次数排序；limit 最大 1000
npm run sentry:triage -- --period 30d --limit 50 --events 5

# 专门看 edit 工具的未知失败
npm run sentry:triage -- --query 'is:unresolved toolName:edit failureKind:unknown'

# 只拉取证据，在当前 Codex 聊天中分析，或稍后重用
npm run sentry:triage -- --collect-only

# 重用已有证据，不再访问 Sentry
npm run sentry:triage -- --input artifacts/sentry-triage/run-XXXXXX/evidence.json

# 也支持 Sentry 下载的单个原始事件 JSON
npm run sentry:triage -- --input /absolute/path/event.json
```

默认目标为 `soft/pi-webapp`，可用 `--project org/project` 更改。默认排除 `sentry-verification`，自定义 Issue 查询会替换默认查询。事件采样始终排除验证环境。

每次创建独立的 `artifacts/sentry-triage/run-*` 目录，避免覆盖之前的结果。`artifacts/` 已被 Git 忽略。

| 文件 | 内容 |
| --- | --- |
| `evidence.json` | Issue 摘要、事件异常和 breadcrumbs、诊断上下文、采样范围 |
| `prompt.md` | 本次分析的规则和输入位置 |
| `report.schema.json` | 结构化输出格式 |
| `report.json` / `report.md` | 已校验的分类、修复判断、证据、代码位置和下一步 |
| `analysis.json` / `codex.log` | Codex 原始分析结果及运行日志；失败时不一定存在 |

报告只在完整性校验通过后写出。Issue 列表查询失败会直接退出；某个 Issue 的事件读取失败会记录采集限制，要求对该 Issue 判为证据不足，不能悄悄丢弃。

## 判断规则

| 分类 | 含义 |
| --- | --- |
| `app_bug` | 有证据支持的 pi-webapp 程序缺陷 |
| `dependency_or_external` | Pi、插件、网络或外部服务问题 |
| `expected_tool_failure` | 已识别的正常工具失败结果；不代表用户任务成功 |
| `monitoring_gap` | 错误分类、上报级别、重复采集或诊断信息的缺口 |
| `insufficient_evidence` | 无法确认根因，需要补充证据 |

修复判断为 `fix`、`no_fix`、`monitor` 或 `investigate`，同时输出 P0–P3 优先级和 high/medium/low 置信度。分类是模型的有证据分析，仍需审阅。脚本校验枚举、Issue 覆盖和部分判断约束，不能代替对根因的验证。

每个 Issue 有一个主要结论，并允许附带独立发现。例如 `edit: unknown` 的实际失败原因可以判为证据不足，同时建议补充监控分类；不能把两者合并成“已确认编辑功能 BUG”。

## 数据和范围

- 默认分析最近活跃的未解决问题，不是所有历史错误。需要分析已解决问题时使用自定义 `--query`。
- `issueLimitReached` 为 true 时，可能还有未读取的 Issue；增加 `--limit` 或缩小查询范围。每个 Issue 的事件是近期样本，不是随机采样，也不保证覆盖所有版本。
- `count`、`lifetime` 和所选时间内的统计可能不同；采集限流也会少计事件。用户数为 0 不能证明没有影响用户，`handled=true` 不能证明没有功能故障。
- 报告记录本地 Git revision。工作区可能含未提交修改，本地代码不一定等于事件发布版本。报告应说明版本匹配的证据或限制。
- 不保留事件中的 request、user、附件、frame vars 或任意 extra 字段。异常文本与 breadcrumbs 仍可能含业务信息；证据、报告及运行日志是本地诊断资料，不进入 Git 或 npm 包。Codex 会读取这些证据并通过当前配置的模型服务分析。
- Codex 用 `--sandbox read-only` 分析源码，最终报告由宿主脚本保存。规则禁止在分析中修改代码、更新 Sentry、发消息或读取凭据。无需在 pi-webapp 运行时配置查询凭据。

参考：[Sentry CLI 安装](https://cli.sentry.dev/getting-started/)、[Issue 命令](https://cli.sentry.dev/commands/issue/)、[Codex 非交互运行](https://learn.chatgpt.com/docs/non-interactive-mode)。
