# Command line

This page is the reference for the `pi-webapp` command, its exit behavior and every message it prints.

## Synopsis

```text
pi-webapp [start] [Pi arguments]
pi-webapp status
pi-webapp stop [--force]
pi-webapp --help
```

Run it with `npx pi-webapp …`, or as `pi-webapp …` after `npm install -g pi-webapp`. In a source checkout, `npm run start`, `npm run status` and `npm run stop` call it for you.

The command manages one **background service** per Pi data folder. Whatever the command, it exits with code `0` on success and `1` on any error (including a usage error).

## `pi-webapp` and `pi-webapp start`

Starts the service, or reopens it if it is already running.

| Situation | Result |
| --- | --- |
| Not running | Starts a detached background service in the **current directory** (which becomes a workspace), waits up to about a minute for it to be ready, prints its PID and address, then opens your browser (see below). |
| Already running | Prints the existing address and opens your browser. The current directory is **not** added. |
| Another start in progress | Prints `pi-webapp 正在启动` ("starting"). |

Any argument that isn't `start`, `status` or `stop` is passed to Pi unchanged, for example flags listed by `pi --help`. Three are refused because the service needs Pi's RPC mode: `--mode`, `--print` and `-p` (`后台启动不支持覆盖 Pi 的运行模式`: "background start can't override Pi's run mode").

An unknown first word that doesn't start with `-`, such as `pi-webapp foo`, prints the usage line and exits with `1`.

**When the browser opens.** After a successful start, and when reopening, the launcher opens the address in your default browser unless one of these applies: `PI_WEBAPP_AUTO_OPEN=0` is set, you are in an SSH session (`SSH_CONNECTION`, `SSH_TTY` or `SSH_CLIENT`), you are on Linux without `DISPLAY` or `WAYLAND_DISPLAY`, or it runs inside the desktop app. Open the printed address yourself then.

## `pi-webapp status`

Prints whether the service is running and its address, and never changes anything.

```text
pi-webapp 正在运行：http://127.0.0.1:52395/#<token>
```

It prints `pi-webapp 正在启动` while a start is in progress and `pi-webapp 未运行` when nothing is running. Any extra argument gives `用法：pi-webapp status`.

## `pi-webapp stop [--force]`

Asks the running service to shut down and waits up to about 40 seconds.

```text
pi-webapp 已停止
```

Stopping ends all running chats and every terminal. The service first asks its plugins to save and release their views, and refuses to stop if one can't ([Troubleshooting](../troubleshooting#stop-is-refused-because-a-plugin-view-has-not-saved)).

`--force` skips that save check. If the service doesn't respond within five seconds, it ends the background process and its child processes directly. **Unsaved plugin edits can be lost.**

If nothing is running, it prints `pi-webapp 未运行` and exits `0`.

## `pi-webapp --help`

Prints the usage line (`-h` works too):

```text
用法：pi-webapp [start|status|stop [--force]] [Pi 参数]
```

## Messages {#messages}

The launcher prints Chinese only. This table translates what you may see.

| Message (Chinese) | Meaning |
| --- | --- |
| `pi-webapp 已在后台运行（PID n）：<address>` | Started in the background with this PID. |
| `停止服务：pi-webapp stop（源码目录中可运行 npm run stop）` | To stop it, run `pi-webapp stop` (`npm run stop` in a source checkout). |
| `pi-webapp 已在后台运行：<address>` | It was already running. |
| `pi-webapp 正在运行：<address>` | `status`: running at this address. |
| `pi-webapp 正在启动` | A start is in progress. |
| `pi-webapp 未运行` | Not running. |
| `pi-webapp 已停止` | Stopped. |
| `pi-webapp 已强制停止` | Force-stopped. |
| `pi-webapp 正在启动，请稍后再停止` | Still starting; wait before stopping. |
| `pi-webapp: 强制停止将跳过插件视图的保存确认，未保存的编辑可能丢失。` | Warning: `--force` skips the plugin save check. |
| `pi-webapp: 服务 5 秒内没有响应强制停止，正在直接结束后台进程及其子进程。` | The service didn't answer, so its processes are being ended directly. |
| `pi-webapp: 停止已取消：插件保存或释放未完成，服务及数据已保留。…` | Stop cancelled because a plugin view hasn't saved. |
| `pi-webapp: 停止超时。后台进程 PID：n；日志：<path>` | The stop didn't finish in time. |
| `pi-webapp: 无法结束后台进程 PID：n` | The process could not be ended. |
| `当前没有本地图形桌面，请手动打开上方地址。` | No local desktop; open the address above yourself. |
| `无法自动打开浏览器，请手动打开上方地址。` | The browser couldn't be opened; open the address yourself. |
| `pi-webapp: 需要 Node.js 22.19 或更新版本。` | Node.js is too old. |
| `pi-webapp: 找不到构建后的扩展。请先运行 npm run build。` | A source checkout hasn't been built. |
| `pi-webapp: 后台启动不支持覆盖 Pi 的运行模式` | You passed `--mode`, `--print` or `-p`. |
| `pi-webapp: Pi 版本 X 不受支持，需要 0.87.1 或更新版本。请更新 Pi 后重试。` | The Pi on your `PATH` is too old. |
| `未找到 Pi，正在通过 npm 安装 @earendil-works/pi-coding-agent …` | No Pi was found, so the launcher installs one globally with npm. This only happens outside the normal npm package. |
| `pi-webapp: Pi 安装失败。请手动运行 npm install -g --ignore-scripts @earendil-works/pi-coding-agent` | That install failed; run the command yourself. |
| `pi-webapp: Pi SDK 版本不匹配：… 需要 x，实际为 y。请重新安装 pi-webapp；全局 Pi 未修改。` | The bundled Pi packages don't match the expected version. Reinstall pi-webapp. |
| `pi-webapp: 后台启动超时。日志：<path>` / `Pi 启动超时。日志：<path>` | The service didn't become ready in time. Read the log. |
| `pi-webapp: 后台进程退出（代码 n）。日志：<path>` / `Pi 提前退出（代码 n）。日志：<path>` | The service or Pi exited during startup. Read the log. |
| `pi-webapp: 新版启动失败，正在恢复旧版服务` | After an update, the new version didn't start; the old one is being restored. |
| `pi-webapp: 旧版恢复失败。日志：<path>` | Restoring the old version also failed. |
| `用法：pi-webapp [start\|status\|stop [--force]] [Pi 参数]` | Usage. |

## Source-checkout scripts

| Script | Does |
| --- | --- |
| `npm run start` | Builds, then runs `pi-webapp`. |
| `npm run dev` | Runs `pi-webapp stop --force`, builds, then starts. Handy while developing; it discards unsaved plugin edits. |
| `npm run status` | `pi-webapp status`. |
| `npm run stop` | `pi-webapp stop`. |

## Inside Pi: `/web`

In a Pi terminal with the extension installed, `/web` opens the browser view of the current session ([Use it from the Pi terminal](../use-from-pi)). It isn't part of the `pi-webapp` command.
