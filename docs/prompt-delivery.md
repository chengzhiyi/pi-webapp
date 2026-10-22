# 运行中追加提示词：引导与排队（ORI-18）

## 需求与交互

当前运行时输入框虽可编辑，但前后端都拒绝发送，用户只能先暂停任务再补充信息。实现两个原生投递语义，不创建并发 Agent，不通过「暂停 + 新发消息」模拟引导。

| 状态/动作 | 行为 |
| --- | --- |
| 空闲，Enter/发送 | 保持现有普通消息、插件指令及继续能力 |
| 运行中，引导 / Ctrl/Cmd+Enter | Pi `steer`：在下一个输入边界接收，调整当前执行；不会强杀当前模型请求或工具 |
| 运行中，排队 / Enter | Pi `followUp`：当前任务的工具调用与引导消息处理完成后，再执行后续请求 |
| Shift+Enter | 换行，不提交；输入法组合状态下 Enter 不提交 |
| 暂停 | 独立控制，不因有草稿而变成发送；SDK 原生待处理消息保留，继续后处理 |
| 已有交互或审批 | 先完成该交互，不允许追加消息绕过 |

运行中可通过附件入口、拖放、粘贴追加文件。指令菜单仅保留文件入口；斜杠指令不作为追加消息执行，因为 Pi 会在队列投递前立即派发扩展命令。运行中仍禁止修改模型。发送期间防止重复提交，失败恢复原草稿与附件；后端仅在接受后消费附件回执，不自动重试结果不明的请求。

## 队列与生命周期

- 使用 Pi 原生消息队列，遵守用户已有 `steeringMode` / `followUpMode` 设置（默认逐条）；两类队列中引导优先，排队等待当前任务完成。
- SDK 会话通过 `getSteeringMessages()` / `getFollowUpMessages()` 与 `queue_update` 投影只读待处理列表，未被 Pi 消费前不作为用户历史回显。消费时由真实会话消息进入历史。
- SDK 切换会话不停止后台工作，待处理列表随会话隔离；刷新、断线重连从服务端快照恢复。
- TUI `/web` 使用 Pi `deliverAs`，包括新建会话后的 replacement context；扩展上下文仅公开 `hasPendingMessages()`，因此只展示原生待处理状态，不伪造详细列表。状态随 Pi 生命周期事件刷新。
- 队列是运行时状态，不跨进程退出/服务重启保存。暂不提供编辑、撤回、重排或持久化；避免维护第二套与 Pi 不一致的队列。

## 实现边界

- 契约：`src/contracts/bridge-contract.ts`，增加可选 `PromptDelivery` / `promptQueue` / `hasPendingPrompts`，保持 schema v1 兼容；`bridge-events.ts` 验证新增字段。
- HTTP：`POST /api/message` 可选 `delivery: "steer" | "followUp"`。保留旧版空闲请求行为，运行中未明确模式则拒绝；非法模式、错误来源/令牌、过期会话、审批和斜杠指令均校验。
- 运行时：`prompt-delivery.ts` 为共享守卫；SDK 将模式映射至 `prompt(..., { streamingBehavior })`，TUI 映射至 `sendUserMessage(..., { deliverAs })`。上传读盘后再次校验目标运行时；UI 忙碌但服务端刚好完成时，明确模式仍可作为正常新消息处理。
- UI：`PiConversation.tsx` 保持独立暂停，提供双按钮和快捷键；`PiPromptQueue.tsx` 只读展示原生待处理信息。追加消息不使用乐观历史气泡。

## 验证

自动化覆盖：原生引导优先/后续排队顺序、图片内容投递、附件失败回执保留、空闲竞态、后台会话隔离、暂停保留与继续消费、TUI 新建会话后投递、鉴权/来源/会话/审批守卫、事件契约、桌面和移动浏览器按钮/快捷键、失败草稿恢复、刷新队列恢复与真实历史去重。测试使用本地受控模型流，不调用外部模型。

主要测试：`test/prompt-delivery.test.ts`、`test/browser/prompt-delivery.spec.ts`，以及 `bridge` / `attachments` / `extension-flow` / `pause-resume` / `background-sessions` 回归。
