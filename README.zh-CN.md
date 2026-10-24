# pi-webapp

### 让 Pi 编程 Agent，拥有一个看得见、用得顺的工作台。

把 AI 对话、项目文件、终端和 Git 放在同一个界面中，不必放弃 Pi 的工具、技能和终端工作流。在浏览器里直接使用，打开独立桌面窗口，或从已有 Pi 会话一键进入。

[English](README.md) · [快速开始](#快速开始) · [下载桌面端](#桌面端下载) · [使用指南](docs/zh/getting-started.md) · [npm](https://www.npmjs.com/package/pi-webapp)

**桌面测试版 build 10：** [macOS · Apple 芯片](https://github.com/chengzhiyi/pi-webapp/releases/download/desktop-v0.1.28-b10/pi-0.1.28-desktop.10-mac-arm64.dmg) · [macOS · Intel](https://github.com/chengzhiyi/pi-webapp/releases/download/desktop-v0.1.28-b10/pi-0.1.28-desktop.10-mac-x64.dmg) · [Windows x64](https://github.com/chengzhiyi/pi-webapp/releases/download/desktop-v0.1.28-b10/pi-0.1.28-desktop.10-win-x64.exe) · [Linux x64](https://github.com/chengzhiyi/pi-webapp/releases/download/desktop-v0.1.28-b10/pi-0.1.28-desktop.10-linux-x86_64.AppImage)。请核对 [SHA-256](https://github.com/chengzhiyi/pi-webapp/releases/download/desktop-v0.1.28-b10/SHA256SUMS)；测试包未签名或无发布者身份，macOS 未公证。[安全安装说明](#桌面端下载)。

[![Pi 工作台：左侧项目会话，中间 Agent 对话，右侧代码高亮预览](assets/readme/workbench.png)](assets/readme/workbench.png)

*一边跟进对话，一边查看消息中链接的源码。截图来自真实界面，使用英文演示数据，并非真实模型执行记录。*

```bash
npx pi-webapp
```

**Web 一条命令启动，桌面端自带运行时，底层仍是你熟悉的 Pi。**

## 为什么选择 pi-webapp？

- **少切窗口，多关注代码。** 一边跟进 Agent，一边查看文件、运行命令、审查差异，让对话与项目上下文留在一起。
- **多个项目，任务不中断。** 各聊天独立运行；切换工作区或新开对话，不会打断原来正在执行的任务。
- **不只看到答案，也能看懂过程。** 流式回复、可展开的推理和工具调用、Token 用量及执行轨迹，让进度更容易掌握。
- **增强 Pi，而不是另起一套。** 继续使用 Pi 的会话存储、模型选择、技能与扩展生态，新增的是可视化工作台，而非替代 Agent 引擎。

## 看图了解工作流

**对话 → 查看源码 → 审查改动 → 运行验证。** 上方工作台把对话和代码放在一起；同一个工具面板，还能让你从差异审查直接进入终端验证。

| 提交前，看清每一处改动 | 不离开对话，直接运行验证 |
| --- | --- |
| [![Git 面板：已暂存的测试，以及包邮门槛修复的红绿差异](assets/readme/git-review.png)](assets/readme/git-review.png) | [![内置终端：实际运行演示项目测试，2 项通过、0 项失败](assets/readme/terminal.png)](assets/readme/terminal.png) |
| 对照差异审查，按需暂存要提交的文件。 | 在项目目录执行命令，保留当前对话上下文。 |

*点击图片可查看原图。截图使用隔离的演示仓库，终端实际运行了两项回归测试；不使用提供方凭据或私有项目数据。[图片生成与维护说明](assets/readme/README.md)。*

## 核心功能

| 能力 | 你可以做什么 |
| --- | --- |
| **实时 Agent 对话** | 发送消息与图片/文件附件，暂停与继续任务，切换模型及思考级别；在上下文中阅读 Markdown、代码、推理和工具结果。 |
| **多项目与多会话** | 发现已有 Pi 会话、添加工作区，在独立运行的聊天之间切换；回来时继续查看输出和待处理的插件交互。 |
| **对话旁的文件预览** | 浏览工作区，点击聊天中的文件路径，在只读标签页查看高亮代码、Markdown 与图片。 |
| **真正的交互式终端** | 在工作区启动 shell，交互输入、Ctrl+C；切换聊天或面板时保留进程与输出。 |
| **Git 审查与操作** | 查看改动和内联差异、逐文件暂存/取消暂存、提交暂存区、创建/切换本地分支，并用分支关系图浏览提交历史。 |
| **灵活的工作台布局** | 调宽、分栏、展开工具面板，或进入工作区专注模式，同时保留导航入口。各聊天保留自己的工具标签，直到网页刷新。 |
| **模型、技能与插件** | 配置提供方和模型，管理 Pi 软件包/扩展/技能，启停内置文件、终端与 Git；兼容的 Web 插件还可贡献自己的界面。 |
| **浏览器与桌面入口** | 用后台启动器打开 Web，从 Pi 终端输入 `/web`，或运行自带 Node/Pi 的 Electron 桌面应用。 |

> 聊天独立运行，但同一工作树中的文件和 Git 改动是共享的。切换聊天不会停止任务；停止服务会结束其后台任务。终端与 Agent 工具使用你的系统权限，不是沙箱环境。

## 快速开始

### Web：一条命令启动

需要 **Node.js 22.19+** 和 npm。在项目目录运行：

```bash
npx pi-webapp
```

启动器会在后台启动 Pi，并在本地图形桌面打开默认浏览器。未安装 Pi 时，会自动安装官方 `@earendil-works/pi-coding-agent`；已有 Pi 需要 **0.87.1+**，旧版本不会被自动覆盖。再次执行命令会重新打开已有服务。无图形界面时显示本地地址；设置 `PI_WEBAPP_AUTO_OPEN=0` 可关闭自动打开。

1. 进入「**设置 → 模型**」，配置提供方并选择有权使用的模型。
2. 选择或添加工作区，开始一次对话。
3. 打开对话右上角的工具面板，在 Agent 旁边使用「**文件**」「**终端**」或「**Git 改动**」。

模型访问权限需自行配置；本地界面不等于离线推理。请勿分享带访问令牌的本地 URL，也不要把服务直接暴露到公网。

```bash
npx pi-webapp status   # 查看运行中的服务地址
npx pi-webapp stop     # 完成当前任务后停止服务
```

习惯全局命令？先运行 `npm install -g pi-webapp`，再运行 `pi-webapp`。

**升级：** 通过 npm 后台启动器运行时，可在「设置 → 通用设置 → 应用更新」中「升级并重启」；新版启动失败会回退。请先结束活跃任务。源码运行和 Pi 终端 `/web` 页面仅显示版本信息，不能从网页重启。详见[更新指南](docs/zh/updates.md)。

### 已经在终端使用 Pi？

```bash
pi install npm:pi-webapp
pi
```

在 Pi 中输入 **`/web`** 即可。浏览器与该终端会话保持同步，Agent、工具和会话存储继续由 Pi 管理；退出该 Pi 进程会结束其服务。

## 桌面端下载

**最新桌面测试版：[pi 0.1.28 · build 10](https://github.com/chengzhiyi/pi-webapp/releases/tag/desktop-v0.1.28-b10)。** 请按系统与芯片选择安装包：

| 平台 | 下载 |
| --- | --- |
| **macOS · Apple 芯片（arm64）** | [下载 DMG](https://github.com/chengzhiyi/pi-webapp/releases/download/desktop-v0.1.28-b10/pi-0.1.28-desktop.10-mac-arm64.dmg) |
| **macOS · Intel（x64）** | [下载 DMG](https://github.com/chengzhiyi/pi-webapp/releases/download/desktop-v0.1.28-b10/pi-0.1.28-desktop.10-mac-x64.dmg) |
| **Windows · x64** | [下载 EXE 安装包](https://github.com/chengzhiyi/pi-webapp/releases/download/desktop-v0.1.28-b10/pi-0.1.28-desktop.10-win-x64.exe) |
| **Linux · x64** | [下载 AppImage](https://github.com/chengzhiyi/pi-webapp/releases/download/desktop-v0.1.28-b10/pi-0.1.28-desktop.10-linux-x86_64.AppImage) |

[全部版本](https://github.com/chengzhiyi/pi-webapp/releases) · [SHA256SUMS 校验文件](https://github.com/chengzhiyi/pi-webapp/releases/download/desktop-v0.1.28-b10/SHA256SUMS) · [构建与运行时信息](https://github.com/chengzhiyi/pi-webapp/releases/download/desktop-v0.1.28-b10/desktop-release.json)

**build 10 已分离桌面外壳与业务包更新。** 可安全连接已有 npm 0.1.26/0.1.27 后台，不停止其任务。手动安装一次此外壳后，兼容的 `pi-webapp` 业务包可在「设置 → 应用更新」中更新到用户目录；重启后台前，请先完成聊天任务并关闭终端。

桌面应用名为 **pi**，自带 Node 和 Pi，无需另装运行时。支持复用兼容的 Web 服务、在浏览器中打开同一服务，以及退出时选择是否保留后台任务。模型凭据、Git/SSH 配置和项目工具链仍需自行准备。

- **安装：** macOS 从 DMG 将 **pi.app** 拖入“应用程序”；Windows 运行 EXE；Linux 为 AppImage 添加执行权限后运行，不支持 FUSE 时可参考该版本发布说明中的替代方式。
- **核对：** 对照同一 Release 的 `SHA256SUMS` 校验安装包，在「pi → 关于 pi」确认 **build 10**。替换前先退出旧桌面，不要删除 `~/.pi`。
- **测试版边界：** 当前为自愿参与的预发布测试包，不是具有发布者签名的稳定发行版。macOS 使用 ad-hoc 临时签名、未经过 Apple 公证，可能被 Gatekeeper 拦截；请按 [macOS 测试安装说明](docs/desktop-testing.md)核验，失败就停止。Windows/Linux 安装包未签名。不要全局关闭系统安全保护。桌面外壳更新仍需手动安装，业务包更新在应用设置中进行；暂不包含 Windows ARM 和 Linux ARM。

## 技术架构亮点

**一套 Agent 引擎，多种使用入口，插件化工作台。** Pi 负责模型执行、工具与会话持久化；pi-webapp 负责界面、会话编排与工作区工具。

[![架构图：浏览器与 Electron 复用 React 工作台，经本地 Node 宿主连接 Pi 引擎与工作区插件](assets/readme/architecture-zh.svg)](assets/readme/architecture-zh.svg)

*共享的是界面；会话编排、Agent 执行与工作区能力，仍然各司其职。*

| 设计 | 带来的价值 |
| --- | --- |
| **薄 Pi 适配层，独立宿主职责** | Agent 接入保持轻量，服务编排、浏览器 UI 与工作区能力各有归属，避免所有逻辑挤进单一扩展入口。 |
| **类型化、可校验的跨端契约** | 浏览器只依赖传输 DTO，不直接耦合 Node/Pi 运行时对象；HTTP 动作与 NDJSON 事件明确划分命令和实时状态更新。 |
| **能力插件化，而非页面堆叠** | Git、文件和终端分别拥有 server/client/contracts 与清理逻辑，由注册表分发请求；标签、停靠、专注模式和会话身份交给宿主工作台。 |
| **面向生命周期的会话管理** | 离开聊天仍保留后台进度与待处理交互；切换聊天保留工具资源，关闭标签则释放对应资源。 |
| **宿主边界上的操作保护** | 本地传输校验令牌与请求来源；文件预览限制工作区及符号链接范围；Git 写入拒绝过期状态，并协调同工作树的已知聊天。这些检查不等于操作系统沙箱。 |
| **多入口复用同一套界面** | React + TypeScript 构建工作台，Vite/esbuild 完成打包，Electron 提供桌面外壳，无需另维护一套桌面对话 UI。 |

源码导航：`src/adapters/pi/` → Pi 入口 · `src/host/` → 前后端宿主 · `src/plugins/builtin/` → 工作区能力 · `src/contracts/` → 跨端契约 · `web/src/ui/` → 共享 UI · `desktop/` → Electron 外壳。

深入了解：[架构与职责划分](docs/architecture.md) · [Web 插件接入与生命周期](docs/web-plugins.md)。

## 使用指南与开发

- **新用户：** [首次对话](docs/zh/getting-started.md) · [会话管理](docs/zh/sessions.md) · [工作区工具](docs/zh/workspace-tools.md)
- **配置与排错：** [模型、软件包与技能](docs/zh/configuration.md) · [版本更新](docs/zh/updates.md) · [常见问题](docs/zh/troubleshooting.md)
- **参与开发：** [架构说明](docs/architecture.md) · [Web 插件](docs/web-plugins.md) · [桌面构建](docs/desktop.md)

指南随源码演进，可能与你安装的版本不同；桌面端支持范围以上方已核实的下载链接及对应版本发布说明为准。

### 本地开发

```bash
npm ci
npm run check
npm test
npm run build
npm run start
```

`npm run start` 会构建并启动后台服务。修改扩展代码后，运行 `npm run stop` 再运行 `npm run start`；仅刷新网页不会替换桥接代码。使用 `pi -e .` 开发时，重新构建后在 Pi 中输入 `/reload`，再输入 `/web`。

桌面开发：`npm run desktop:prepare` → `npm run desktop:start`；`npm run desktop:package` 在 `desktop-release/` 生成当前系统的安装包。可信本地插件联调可参考[插件说明](docs/web-plugins.md)中的 `PI_WEBAPP_PLUGIN_DEV_ROOTS`。

---

**让下一次 Pi 任务，从一个可视化工作台开始：** 运行 `npx pi-webapp`，或[体验桌面测试版](#桌面端下载)。如果它让你的工作更顺手，欢迎 [Star 项目](https://github.com/chengzhiyi/pi-webapp)帮助更多人发现，也欢迎[提交反馈与可复现的问题](https://github.com/chengzhiyi/pi-webapp/issues)，一起完善工作流。

基于 MIT 许可证开源。详见 [LICENSE](LICENSE)。
