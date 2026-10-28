# 插件、下载与升级修复：根因和验证

日期：2026-10-28。基于 `464dd89d43f1f716ff1c3bc38c2e54593a9f98a4`，
初次验证分支 `codex/plugin-update-recovery`；当时未推送或发布。
2026-10-29 按用户后续要求集成至 `alpha`，远端 CI 与发布结果以对应 Actions 记录为准。

## 环境分别核实

| 对象 | 观察结果 |
| --- | --- |
| 原始源码目录 | package.json 0.1.29；本地 SDK 0.87.1、协议包 0.1.0；构建产物仍为 10 月 17 日 |
| 隔离修复目录 | 锁文件安装 SDK 1.3.0、协议包 0.1.1；本次重新构建并验证 |
| 用户后台只读运行记录 | 0.1.36、desktop 模式；desktop-update 指向 0.1.37；pair 日志仍为 0.1.37 / selected |
| 兼容性验证安装 | 单独临时前缀中的 SDK / AI / core 1.4.0，未改变发布依赖的 1.3.0 锁定 |

源码版本、构建身份、依赖和正在运行的安装彼此独立，不能互相替代。
上述用户运行记录仅作只读核对，未取消其事务或处理用户视图。

## 已确认根因及修复

| 问题 | 可复现证据 | 代码行为变化 |
| --- | --- | --- |
| alpha 更新不能完成或界面未反映新版 | 已选择旧目标会阻止换通道；实际后台重启后，设置分类卸载会销毁 readiness 轮询 | 通道偏好严格持久化；可安全取消未完成事务；稳定 AppUpdateProvider 统一拥有升级观察；只在实际运行版本和插件健康准入匹配后提交 |
| Close editors before updating | 隐藏 controller 没有可见编辑器仍能阻止 freeze；controller 收到 committed 后旧实现尝试作者视图的 flush | controller 是经过审查的非作者角色，仅等待在途服务端动作；作者视图仍要求真实保存确认；controller 关闭不伪造 ACK |
| 刷新后的 Unconfirmed controller | 注册成功但本地登记尚未写入时刷新，会遗留无法定位的注册；刷新后的 journal 无条件展示旧 controller | 请求前持久化精确 capability；注册幂等、延迟注册取消保护；控制器可精确核对退役；未知作者视图保留恢复记录 |
| 更新、卸载、关闭无法完成 | prepare 在保存确认前写 selected；失败后 pair 持续阻止管理；插件发布失败会保留全局冻结 | 下载、验证、准备不选版本；可逆 restart lease 后才选择；取消按收据 CAS；错误局限于插件；失败恢复同一 generation 的旧 worker |
| 模型 fetch failed | 默认请求连接超时，而显式环境代理可到达同一服务；真实 SDK 到本地 503、断流与生命周期冻结可分别复现 | 中立 HTTP 传输统一环境代理和 NO_PROXY；模型适配层单独记录脱敏 cause、阶段、错误码、关联 ID；阻塞发生在 HTTP 前时明确记录 lifecycle |

另外，公开 npm 下载同一 15,675,423 字节插件包时，默认请求 15 秒仅收到
2,399,696 字节；显式代理约 2062 ms 完整收取。未注入 fetch 的生产默认
安装器随后从公开 npm 完成 0.1.2 下载、SRI、解包和全部资源校验。修复是
把插件下载接到中立传输层，没有放宽超时、完整性或 TLS 检查。

历史三次模型错误只保留了 `fetch failed`，缺少当时底层 cause，因此不能
断言它们全部具有同一个根因，也不能断言它们由插件导致。

## 架构调整

详细职责和取舍见 [架构与生命周期说明](plugin-update-recovery.md)。

- `http-transport` 负责 HTTP/HTTPS 环境代理、NO_PROXY、响应流和连接释放，
  插件安装器不依赖模型模块。显式自定义 fetch 保持其原有语义。
- SDK Adapter 依赖公开能力契约，启动时用独立内存会话和确定性流验证隐藏工具、
  model-only、嵌套调用、parentToolCallId 和权限守卫。缺失能力只停用相关
  托管工具。实际 1.4.0 测试通过，证明原先精确版本拒绝不等于接口不兼容。
- 已兼容插件独立更新。主程序只为真实协议/数据冲突协调插件，仍保留 hostRange、
  capability、资源完整性、工具权限和数据迁移检查。
- View Coordinator 区分作者视图与 controller，分别处理初始化、关闭、失联、
  刷新和恢复。旧本地备份先复制，再挂载新编辑器，防止恢复材料被新视图覆盖。
- Update Coordinator 持久化 downloading → validating → prepared → selecting →
  selected → restart-requested → committed，以及取消/失败终态和历史。
  prepared 不写选择指针；保存确认、暂停 worker、选择和重启各有失败规则。
- Restart lease 保留活动指针、代次和 asset 身份；失败时重新获取 custody、
  核对指针后恢复同代 worker 和原视图。释放 custody 失败的部分暂停也会恢复。
- 跨进程取消需要精确回退字节和当前 launcher 身份；另一个仍活跃的后台不能
  仅凭不同 nonce 取消交接。pair 的磁盘编码保留旧 schema-1 可读的 phase，
  用附加 lifecycle 字段表达新状态，避免旧版回退解析失败。
- AppUpdateProvider 属于应用根部，Settings 和侧栏共享安装锁、状态、错误和轮询。
  对话框、模型设置或页面布局不再拥有升级过程的寿命。

审查额外复现并修复了 custody 释放失败后的空 worker 误报 active、manager
提交后记账失败未进入局部恢复、以及第二个活跃 updater 误取消交接三个问题。
全量测试还捕获正常退出时状态文件与 stop marker 的竞态；现在按状态先移除的
顺序退出，并在认定拒绝前重新核实当前所有者，真实拒绝仍然会阻止关闭。

## 执行结果

| 验证 | 结果 | 证据性质 |
| --- | --- | --- |
| 后端/前端类型检查 | PASS | `npm run check` |
| 完整构建 | PASS | `npm run build`；仍有既有 source-map 插件默认导出警告 |
| Node 全量 | 512 PASS / 0 FAIL / 1 SKIP | 单元、真实文件系统、HTTP、worker、SDK 和进程测试；SKIP 是 Windows 专用 PTY |
| 桌面全量 | 94 PASS / 0 FAIL | Node 桌面测试，部分使用 fake-Pi 进程；不等于原生安装器认证 |
| 相关 Chromium 浏览器 | 31 PASS / 0 SKIP / 0 flaky | built App、真实 HTTP/worker；含公开 npm 安装，其他 registry/模型传输注明为夹具 |
| 公开 npm 0.1.0 → 0.1.2 | 2 PASS | 1440/390 两种视口；真实 metadata/tgz/SRI，无替代归档或隐式重试 |
| 实际 SDK 1.4.0/AI/core 1.4.0 | 9 PASS | 独立前缀执行当前主程序权限、会话、网络及缺能力测试 |
| 实际 App → alpha → 启动器重启 | PASS | 真实 built App、SDK、launcher；发行 metadata/部署复制为本地夹具，无真实宿主 npm 发布 |
| 候选启动失败 → 实际回退 → 取消 → 再升级 | PASS | 真实后台进程和 launcher 选择/回退；临时 profile |

浏览器 JSON 另外检查了每项结果、retry、global errors 和
`shutdown-failed-closed` 注解，未把“页面断言通过但退出失败”计为通过。

公开插件用例覆盖安装、启用、真实画布移动、撤销/重做、PNG 字节、中文路径保存、
卸载重装、保留文件/scene，以及同一 SDK 会话和父页面。刷新恢复用例通过真实
HTTP503 留下未同步几何，验证导出的旧副本，并确认获胜服务端图稿未被恢复副本覆盖。

模型验证只使用本地 HTTP/CONNECT 服务与确定性模型流：覆盖 503、代理、
NO_PROXY、TLS 分类、响应中断、取消、凭据脱敏及 HTTP 前的生命周期阻塞。
未发送真实供应商认证推理请求。

## 可重放

```sh
npm ci
npm run check
npm run build

# 获取已固定完整性的历史回归归档；环境字段在输出 JSON 中。
node scripts/prepare-hosted-ci-fixtures.mjs
# 将输出的 environment 字段导出后执行：
npm test

# built App + actual SDK + launcher 的隔离 alpha/回退 smoke
node scripts/smoke-update-recovery.mjs

# 已显式安装的其他 SDK 前缀，不安装/升级发布依赖
node scripts/verify-sdk-compatibility.mjs /absolute/sdk-prefix

HOSTED_NPM_VERIFY=1 npx playwright test test/browser/hosted-npm.spec.ts
HOSTED_NPM_VERIFY=1 HOSTED_NPM_UPGRADE_FROM=0.1.0 \
  npx playwright test test/browser/hosted-npm.spec.ts
```

公开 UI 验证默认选择当时真正兼容的发行版；历史归档仍固定 SRI。
`HOSTED_NPM_VERSION` 仅用于显式要求某个预期公开版本的运行，不会改写 npm metadata。

本次完整日志、严格浏览器 JSON、最初失败日志和 alpha 重启截图保存在工作区
`artifacts/plugin-update-recovery/`，不进入发布包或 Git。

## 逐条交付与限制

1. **alpha：已修复并验证。** 包含通道、界面卸载、实际运行版本、失败回退和再次升级。
   真正缺少持久化能力的旧外壳仍会被正确拒绝，不静默更换通道。
2. **Close editors：已修复隐藏 controller 的错误阻塞。** 真实作者视图未保存或仍有
   在途动作时仍会拒绝交接，提供具体视图与恢复路径。
3. **刷新 Unconfirmed controller：已修复。** 注册竞态、失联 controller、初始化失败
   已覆盖。作者视图未确认编辑必须经用户核对/保留恢复；不会自动清空。
4. **插件管理：已修复并验证。** 已完成阶段失败、取消、权限隔离、恢复、启停、卸载、
   再次升级及数据保留验证，未删除锁、清空事务或伪造保存确认。
5. **fetch failed：独立复现并修复代理路径，完善诊断。** 没有将缺乏原始 cause 的历史
   错误全部归为插件或网络同一根因；新诊断可区分对应阶段。

未验证：原生 Electron GUI 和签名安装器的真实 OS 安装、Windows/Linux/Intel Mac
原生 GUI、物理断电、所有浏览器和所有未来 SDK。HTTP 代理与 NO_PROXY 已验证，
SOCKS/PAC 未新增支持。浏览器从未成功存入本地备份的最后编辑无法凭空恢复；界面
明确区分“保留恢复材料”和“已经保存”。这些限制未被计入通过结果。

本次没有直接升级用户当前安装，原后台、图稿和原始目录的本地改动保持原状。

## alpha 分支集成（2026-10-29）

集成远端 `df2a0d9` 的折叠式本地化恢复提示，保留本次精确状态核对、下载恢复副本、
保留恢复记录及显式丢弃操作。类型检查、完整构建、中英文两种视口的提示测试（4 项）、
实际绘图 parity（10 项）与隐藏 controller / 失联编辑器恢复（2 项）已通过。
提示测试的 view API 为模拟；parity 和失联恢复仍使用真实 HTTP、SDK、worker 及绘图备份。

首次 alpha CI 另捕获两处测试契约问题：旧遥测用例要求关闭设置即取消升级，
与应用根部拥有升级观察的修复相冲突；失联恢复用例在新代工具预览仍显示加载中时
立即请求停用，被真实 busy 检查拒绝。现分别覆盖关闭设置后的成功重连与单次超时，
并等待新代预览及真实就绪回报后验证停用/卸载。遥测 27 PASS（1 个既有诊断 SKIP）、
恢复 2 PASS、类型检查通过；未增加固定等待、管理请求重试或放宽视图安全检查。
