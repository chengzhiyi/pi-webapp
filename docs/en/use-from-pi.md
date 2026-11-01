# Use it from the Pi terminal

This page is for people who already work in Pi's terminal interface and want a browser view of that same session.

## Set it up

Install pi-webapp as a Pi package once, then start Pi as usual:

```bash
pi install npm:pi-webapp
cd ~/projects/my-app
pi
```

Inside Pi, type:

```text
/web
```

Pi opens your browser on the workbench and shows the address as a notification in the terminal. The status line changes to `Web 已启动 · /web 重新打开` (the web interface is started; run `/web` to open it again).

If the browser doesn't open (a remote machine, SSH, or no desktop), copy the printed address. If you closed the tab, run `/web` again to get the address back.

You need Node.js 22.19 or later and Pi 0.87.1 or later (`pi --version`). This mode uses **your installed Pi**, not the copy bundled with the web launcher.

## How it behaves

- **The browser mirrors that terminal session.** What you type in either place shows up in both. Pi still owns the agent, the tools and the session file.
- **It lives as long as that Pi process.** Quitting Pi ends the web service and its address. Starting `pi` again and entering `/web` gives you a new address with a new token.
- **No background service.** `pi-webapp status` and `pi-webapp stop` manage the *background launcher*, not this mode. Likewise **Update and restart** in Settings isn't available here; see below.
- **The folder you started Pi in** appears as a workspace, next to any others Pi already knows about.

## Open the browser automatically

Set `PI_WEBAPP_AUTO_OPEN=1` before starting Pi, and Pi runs `/web` for you at startup in the terminal interface:

```bash
PI_WEBAPP_AUTO_OPEN=1 pi
```

This is the one case where `1` matters. For the background launcher, `PI_WEBAPP_AUTO_OPEN=0` is how you stop the browser from opening (see [Environment variables](./reference/environment)).

## Update

From a normal shell, not inside Pi:

```bash
pi update npm:pi-webapp
```

Then restart Pi and enter `/web`. A bare `pi update` updates Pi itself, not the extension. More in [Updates](./updates#update-from-the-pi-terminal-web).

## Prefer the background launcher?

You can switch any time. The sessions are the same files, so a chat you started in the terminal shows up in the web launcher's sidebar, and the other way round. See [Quick start](./getting-started).
