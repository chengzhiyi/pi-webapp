# 命令行

本页是 `pi-webapp` 命令的参考：它的用法、退出行为，以及它打印的每一条消息。

## 用法

```text
pi-webapp [start] [Pi 参数]
pi-webapp status
pi-webapp stop [--force]
pi-webapp --help
```

可以用 `npx pi-webapp …` 运行，或者在 `npm install -g pi-webapp` 之后直接用 `pi-webapp …`。在源码目录里，`npm run start`、`npm run status` 和 `npm run stop` 会替你调用它。

这个命令为每个 Pi 数据目录管理一个**后台服务**。无论哪条命令，成功时退出码都是 `0`，任何错误（包括用法错误）都是 `1`。

## `pi-webapp` 和 `pi-webapp start`

启动服务；如果它已经在运行，就重新打开。

| 情况 | 结果 |
| --- | --- |
| 没有运行 | 在**当前目录**（它会成为一个工作区）启动一个分离的后台服务，最多等大约一分钟让它就绪，打印它的 PID 和地址，然后打开浏览器（见下文）。 |
| 已在运行 | 打印已有的地址并打开浏览器。当前目录**不会**被添加。 |
| 另一次启动正在进行 | 打印 `pi-webapp 正在启动`。 |

任何不是 `start`、`status` 或 `stop` 的参数都会原样传给 Pi，例如 `pi --help` 列出的选项。其中三个会被拒绝，因为服务需要 Pi 的 RPC 模式：`--mode`、`--print` 和 `-p`（`后台启动不支持覆盖 Pi 的运行模式`）。

第一个词是未知的、又不以 `-` 开头，比如 `pi-webapp foo`，会打印用法行并以 `1` 退出。

**浏览器什么时候打开。** 成功启动之后以及重新打开时，启动器会在你的默认浏览器里打开这个地址，除非出现下面任意一种情况：设置了 `PI_WEBAPP_AUTO_OPEN=0`；你在 SSH 会话里（`SSH_CONNECTION`、`SSH_TTY` 或 `SSH_CLIENT`）；你在没有 `DISPLAY` 或 `WAYLAND_DISPLAY` 的 Linux 上；或者它运行在桌面应用内部。这时请自己打开打印出来的地址。

## `pi-webapp status`

打印服务是否在运行以及它的地址，不会改动任何东西。

```text
pi-webapp 正在运行：http://127.0.0.1:52395/#<token>
```

启动进行中时它会打印 `pi-webapp 正在启动`，什么都没运行时打印 `pi-webapp 未运行`。多余的参数会得到 `用法：pi-webapp status`。

## `pi-webapp stop [--force]`

请求正在运行的服务关闭，并最多等待大约 40 秒。

```text
pi-webapp 已停止
```

停止会结束所有正在运行的会话和每个终端。服务会先请它的插件保存并释放它们的视图，如果有哪个做不到，就拒绝停止（[排错](../troubleshooting#stop-is-refused-because-a-plugin-view-has-not-saved)）。

`--force` 会跳过这个保存检查。如果服务在五秒内没有响应，它会直接结束后台进程及其子进程。**未保存的插件修改可能丢失。**

如果没有任何东西在运行，它会打印 `pi-webapp 未运行`，退出码为 `0`。

## `pi-webapp --help`

打印用法行（`-h` 同样有效）：

```text
用法：pi-webapp [start|status|stop [--force]] [Pi 参数]
```

## 消息一览 {#messages}

启动器只输出中文。下表解释你可能看到的消息，以及遇到它时该怎么办。

| 消息 | 含义与建议 |
| --- | --- |
| `pi-webapp 已在后台运行（PID n）：<地址>` | 已在后台启动，PID 是 n。 |
| `停止服务：pi-webapp stop（源码目录中可运行 npm run stop）` | 要停止它，运行 `pi-webapp stop`（源码目录里用 `npm run stop`）。 |
| `pi-webapp 已在后台运行：<地址>` | 它本来就在运行。 |
| `pi-webapp 正在运行：<地址>` | `status`：正在这个地址上运行。 |
| `pi-webapp 正在启动` | 启动正在进行。 |
| `pi-webapp 未运行` | 没有运行。 |
| `pi-webapp 已停止` | 已停止。 |
| `pi-webapp 已强制停止` | 已强制停止。 |
| `pi-webapp 正在启动，请稍后再停止` | 还在启动，等一会儿再停止。 |
| `pi-webapp: 强制停止将跳过插件视图的保存确认，未保存的编辑可能丢失。` | 警告：`--force` 会跳过插件的保存检查。 |
| `pi-webapp: 服务 5 秒内没有响应强制停止，正在直接结束后台进程及其子进程。` | 服务没有应答，所以正在直接结束它的进程。 |
| `pi-webapp: 停止已取消：插件保存或释放未完成，服务及数据已保留。…` | 因为有插件视图还没保存，停止被取消。 |
| `pi-webapp: 停止超时。后台进程 PID：n；日志：<路径>` | 停止没有在规定时间内完成。 |
| `pi-webapp: 无法结束后台进程 PID：n` | 进程无法被结束。 |
| `当前没有本地图形桌面，请手动打开上方地址。` | 这里没有本地桌面，请自己打开上面的地址。 |
| `无法自动打开浏览器，请手动打开上方地址。` | 浏览器没能打开，请自己打开地址。 |
| `pi-webapp: 需要 Node.js 22.19 或更新版本。` | Node.js 太旧。 |
| `pi-webapp: 找不到构建后的扩展。请先运行 npm run build。` | 源码目录还没有构建。 |
| `pi-webapp: 后台启动不支持覆盖 Pi 的运行模式` | 你传了 `--mode`、`--print` 或 `-p`。 |
| `pi-webapp: Pi 版本 X 不受支持，需要 0.87.1 或更新版本。请更新 Pi 后重试。` | 你 `PATH` 里的 Pi 太旧。 |
| `未找到 Pi，正在通过 npm 安装 @earendil-works/pi-coding-agent …` | 没有找到 Pi，所以启动器用 npm 全局安装一个。这只会在正常的 npm 包之外发生。 |
| `pi-webapp: Pi 安装失败。请手动运行 npm install -g --ignore-scripts @earendil-works/pi-coding-agent` | 那次安装失败了，请自己运行这条命令。 |
| `pi-webapp: Pi SDK 版本不匹配：… 需要 x，实际为 y。请重新安装 pi-webapp；全局 Pi 未修改。` | 自带的 Pi 包和期望的版本不一致。请重新安装 pi-webapp。 |
| `pi-webapp: 后台启动超时。日志：<路径>` / `Pi 启动超时。日志：<路径>` | 服务没有及时就绪。请阅读日志。 |
| `pi-webapp: 后台进程退出（代码 n）。日志：<路径>` / `Pi 提前退出（代码 n）。日志：<路径>` | 服务或 Pi 在启动期间退出了。请阅读日志。 |
| `pi-webapp: 新版启动失败，正在恢复旧版服务` | 更新之后新版本没有启动，正在恢复旧版本。 |
| `pi-webapp: 旧版恢复失败。日志：<路径>` | 恢复旧版本也失败了。 |
| `用法：pi-webapp [start\|status\|stop [--force]] [Pi 参数]` | 用法说明。 |

## 源码目录里的脚本

| 脚本 | 作用 |
| --- | --- |
| `npm run start` | 先构建，再运行 `pi-webapp`。 |
| `npm run dev` | 运行 `pi-webapp stop --force`，构建，然后启动。开发时很方便；它会丢弃未保存的插件修改。 |
| `npm run status` | `pi-webapp status`。 |
| `npm run stop` | `pi-webapp stop`。 |

## 在 Pi 里：`/web`

在安装了这个扩展的 Pi 终端里，`/web` 会打开当前会话的浏览器视图（[在 Pi 终端里使用](../use-from-pi)）。它不属于 `pi-webapp` 命令。
