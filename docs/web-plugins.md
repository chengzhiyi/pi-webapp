# Web 插件与聊天控制

## 内置插件与管理

当前目录与启停语义见 [architecture.md](architecture.md)。Git、文件、终端、手绘图集中在 `src/plugins/builtin/<能力>/{server,client,contract}/`，通过宿主注册表接入。浏览器模块沿用协议 v1 的加载校验与生命周期，并声明独立版本的 `workbench` 入口/面板贡献；后端由各插件声明请求处理与资源清理。侧栏「新会话」下方的「插件」提供全局开关，设置中不重复提供插件入口。面向用户的操作说明见[新用户指南](zh/configuration.md)（英文见 [English guide](en/configuration.md)）；本站尚未公开部署。

外部 Pi 扩展不等于可独立卸载的 Web 模块：现有外部协议未声明安全的运行时停用操作，管理页对此展示只读状态，包的安装/移除继续走「包与扩展」。不以隐藏前端入口代替运行时停用。

内置手绘图的入口、工具、保存及资源边界见 [diagrams.md](diagrams.md)。采用内置插件，复用同源 Vite 分包与本地字体；外部 Web 插件的 JS/CSS 资源契约未因此扩大。宿主附加 `workbench.toolViews` 接收工具参数流及结果，在对应工具位置呈现交互图稿；`workbench.beforeSend(sessionId)` 在主对话发送前同步手改，失败则不发送并保留输入。二者为可选原生贡献，不改变外部协议 v1 slots，也不表示实现了通用 MCP Apps/AppBridge 或可直接加载任意远端 HTML。

## 插件接入

宿主通过 `@chengzhiyi/pi-web-protocol` v1 接入 Web 插件。插件包在
`package.json` 中声明 `piWebapp` 清单，提供客户端模块和可选样式；宿主从
Pi 已启用的扩展包中发现插件。客户端通过插槽、交互和面板贡献界面，
通过宿主桥接调用插件 action，不直接依赖 Pi SDK 的业务对象。

开发时先在同级 `pi-extensions` 目录构建插件，再启动宿主：

```sh
# pi-extensions
pnpm install
pnpm build
pnpm dev
```

```sh
# pi-webapp，另一个终端
PI_WEBAPP_PLUGIN_DEV_ROOTS=../pi-extensions/packages/plan-mode npm run start
```

客户端资源变化会触发页面刷新；Pi 扩展入口变化会等待代理空闲后重载。
后端重载串行执行，浏览器插件的模块、样式和清理函数按连接及会话管理，
避免旧加载结果在切换会话后重新激活。浏览器断线保留后端待处理交互。

面板、Markdown 和输入编辑器使用 `web/src/ui/` 的本地 UI 组件。插件管理的列表、详情导航和独立开关样式参照 DSH 的 `packages/client/ui-plugin-manager` 与 `ui-primitives/Switch`，接入本项目的桥接与语言/模态框实现，不引入 DSH 的运行时。

## 暂停与继续

普通聊天的暂停会中止当前请求。继续通过 `/api/resume` 发送隐藏的宿主控制
消息，基于原任务、已有工具结果和部分回复发起新请求，不新增用户气泡。
正在运行、已经完成、存在待处理交互或已切换的会话不能使用通用继续。

计划模式由插件提供提问、审批、修订和预览。审批期间保留草稿、附件和编辑
历史；中断后的恢复沿用原任务上下文。需要重新审批的计划必须获得新的批准，
历史批准记录不会自动恢复执行权限。具体插件配置见 `pi-extensions/README.md`。

## 检查与开发产物

提交前运行：

```sh
npm run check
npm run build
npm test
git diff --check
```

`test/` 中保留自动化回归，包括插件资源、生命周期、SDK 重载和暂停继续。
手动检查可覆盖审批与修订、暂停后继续、页面刷新、会话切换及窄屏布局。

截图、构建日志、运行快照和临时验收脚本统一放在根目录 `artifacts/`，该目录
由 Git 忽略。`docs/` 保留使用和设计说明，不保存逐轮验收记录或本机会话数据。
