# Environment variables

This page lists the environment variables you can set, what each does, its default, and how to apply a change.

Set a variable in the environment of the process that **starts** the service: the shell that runs `npx pi-webapp`, the shell that runs `pi`, or the desktop app's own environment. Other variables used internally by pi-webapp's launcher and tests aren't listed because they aren't supported settings.

## Reference

| Variable | Default | Effect |
| --- | --- | --- |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Pi's data folder. Sessions, credentials, model configuration and pi-webapp's own state (`pi-web/`) all live under it. A leading `~` is expanded. |
| `PI_WEBAPP_AUTO_OPEN` | unset | With the **background launcher**: `0` stops it from opening a browser. With the **`pi` terminal interface**: `1` runs `/web` automatically when Pi starts. Any other value does nothing. |
| `PI_WEB_SENTRY_ENABLED` | unset (off) | `true` turns on Sentry error reporting. Anything else keeps it off. |
| `PI_WEB_SENTRY_DSN` | built-in project | Where reports go when reporting is enabled. Has no effect on its own. |
| `PI_WEB_SENTRY_BROWSER_DSN`, `PI_WEB_SENTRY_NODE_DSN` | the value of `PI_WEB_SENTRY_DSN` | The same, set separately for the page and the service. |
| `PI_WEB_SENTRY_ENVIRONMENT` | `production` | Label attached to reports. |
| `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY` (lowercase also read) | unset | Proxy settings for the outgoing HTTP(S) requests of the background launcher's Pi process, including model requests. |
| `SHELL` (Windows: `COMSPEC`) | `/bin/sh` (Windows: `cmd.exe`) | The program the Terminal tool starts. |
| `PI_WEBAPP_PLUGIN_DEV_ROOTS` | unset | For plugin development only: folders of trusted local plugin sources to load and watch. See [Developers](../developers). |

### Details

**`PI_CODING_AGENT_DIR`.** Pointing it at a new folder gives you a fresh, separate setup: no sessions, no credentials, its own running service. That is also how you can run a second service side by side ([FAQ](../faq#can-i-run-more-than-one-service)). To move to a new location, stop the service, copy the folder and set the variable. See [Files and directories](./files).

**`PI_WEBAPP_AUTO_OPEN`.** Examples:

```bash
# Start the background service but don't open a browser tab
PI_WEBAPP_AUTO_OPEN=0 npx pi-webapp

# Have the Pi terminal UI open the browser view at startup
PI_WEBAPP_AUTO_OPEN=1 pi
```

**Error reporting.** Sentry reporting is off unless `PI_WEB_SENTRY_ENABLED=true`. A DSN, even one inherited from your environment, can't enable it. What is collected when it is on is described in [Security and privacy](../security#error-reporting).

**Proxies.** Set them before starting, for example:

```bash
HTTPS_PROXY=http://proxy.example.com:3128 NO_PROXY=127.0.0.1,localhost npx pi-webapp
```

A proxy URL that can't be parsed makes requests fail with a proxy configuration error.

**Pi doesn't read a `.env` file.** Export variables in your shell profile, or put them on the command line as above.

## Changing the environment {#changing-the-environment}

A running service keeps the environment it started with. Reopening it, refreshing the page or running `npx pi-webapp` again does **not** apply a new value.

1. Finish your work. Stopping ends running chats and terminals.
2. Stop the service the same way you started it:

   ::: code-group

   ```bash [macOS / Linux]
   npx pi-webapp stop
   ```

   ```powershell [Windows PowerShell]
   npx pi-webapp stop
   ```

   :::

3. Start it with the variable set:

   ::: code-group

   ```bash [macOS / Linux]
   PI_WEBAPP_AUTO_OPEN=0 npx pi-webapp
   ```

   ```powershell [Windows PowerShell]
   $env:PI_WEBAPP_AUTO_OPEN = '0'
   npx pi-webapp
   ```

   :::

Other entry points:

- **`/web` in Pi:** set the variable before you start `pi`.
- **Desktop app:** it passes its own environment to the service it starts. If it is reusing a service you started elsewhere, change that service's environment; refreshing the window won't.
