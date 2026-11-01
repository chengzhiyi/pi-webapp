# 环境变量

本页列出你可以设置的环境变量、每个变量的作用和默认值，以及如何让改动生效。

请在**启动**服务的那个进程的环境里设置变量：运行 `npx pi-webapp` 的那个 shell、运行 `pi` 的那个 shell，或者桌面应用自己的环境。pi-webapp 的启动器和测试内部使用的其他变量没有列出，因为它们不是受支持的设置。

## 参考

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Pi 的数据目录。会话、凭据、模型配置和 pi-webapp 自己的状态（`pi-web/`）都在它下面。开头的 `~` 会被展开。 |
| `PI_WEBAPP_AUTO_OPEN` | 未设置 | 对**后台启动器**：`0` 会阻止它打开浏览器。对 **`pi` 终端界面**：`1` 会在 Pi 启动时自动运行 `/web`。其他取值都不起作用。 |
| `PI_WEB_SENTRY_ENABLED` | 未设置（关闭） | `true` 会开启 Sentry 错误上报。其他任何值都保持关闭。 |
| `PI_WEB_SENTRY_DSN` | 内置项目 | 开启上报时报告发往哪里。单独设置没有作用。 |
| `PI_WEB_SENTRY_BROWSER_DSN`、`PI_WEB_SENTRY_NODE_DSN` | `PI_WEB_SENTRY_DSN` 的值 | 同上，只是分别为页面和服务单独设置。 |
| `PI_WEB_SENTRY_ENVIRONMENT` | `production` | 附加在报告上的环境标签。 |
| `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY`（小写形式也会读取） | 未设置 | 后台启动器的 Pi 进程发出的 HTTP(S) 请求（包括模型请求）所用的网络代理设置。 |
| `SHELL`（Windows：`COMSPEC`） | `/bin/sh`（Windows：`cmd.exe`） | 终端工具启动的程序。 |
| `PI_WEBAPP_PLUGIN_DEV_ROOTS` | 未设置 | 仅用于插件开发：要加载并监视的、受信任的本地插件源码目录。见[开发者](../developers)。 |

### 细节

**`PI_CODING_AGENT_DIR`。** 把它指向一个新目录，就得到一套全新、独立的环境：没有会话、没有凭据，有自己运行的服务。这也是并排运行第二个服务的办法（[常见问题](../faq#can-i-run-more-than-one-service)）。要迁移到新位置，请先停止服务，复制这个目录，再设置该变量。见[文件与目录](./files)。

**`PI_WEBAPP_AUTO_OPEN`。** 示例：

```bash
# 启动后台服务，但不要打开浏览器标签页
PI_WEBAPP_AUTO_OPEN=0 npx pi-webapp

# 让 Pi 终端界面在启动时打开浏览器视图
PI_WEBAPP_AUTO_OPEN=1 pi
```

**错误上报。** 除非设置 `PI_WEB_SENTRY_ENABLED=true`，否则 Sentry 上报是关闭的。DSN 即使是从你的环境里继承来的，也无法启用它。开启之后会收集什么，见[安全与隐私](../security#error-reporting)。

**网络代理。** 启动之前设置，例如：

```bash
HTTPS_PROXY=http://proxy.example.com:3128 NO_PROXY=127.0.0.1,localhost npx pi-webapp
```

无法解析的代理 URL 会让请求因为代理配置错误而失败。

**Pi 不会读取 `.env` 文件。** 请在你的 shell 配置里 export 变量，或者像上面那样直接写在命令行上。

## 修改环境 {#changing-the-environment}

运行中的服务会一直沿用它启动时的环境。重新打开它、刷新页面，或再次运行 `npx pi-webapp`，都**不会**应用新值。

1. 先把手头的事做完。停止会结束正在运行的会话和终端。
2. 用你启动它的同样方式停止服务：

   ::: code-group

   ```bash [macOS / Linux]
   npx pi-webapp stop
   ```

   ```powershell [Windows PowerShell]
   npx pi-webapp stop
   ```

   :::

3. 带着变量重新启动：

   ::: code-group

   ```bash [macOS / Linux]
   PI_WEBAPP_AUTO_OPEN=0 npx pi-webapp
   ```

   ```powershell [Windows PowerShell]
   $env:PI_WEBAPP_AUTO_OPEN = '0'
   npx pi-webapp
   ```

   :::

其他入口：

- **Pi 里的 `/web`：** 在启动 `pi` 之前设置变量。
- **桌面应用：** 它会把自己的环境传给它启动的服务。如果它复用的是你在别处启动的服务，请改那个服务的环境；刷新窗口没有用。
