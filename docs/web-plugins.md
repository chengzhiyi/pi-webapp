# Web 插件与聊天控制

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

面板、Markdown 和输入编辑器使用本地引入的 UI 组件；来源与改动说明见
[组件说明](../web/src/ui/dsh/README.md)，版权说明保留在
[THIRD_PARTY_LICENSE.txt](../THIRD_PARTY_LICENSE.txt)。

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
