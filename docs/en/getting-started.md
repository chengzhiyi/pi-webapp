# Install & first conversation

## 1. Check prerequisites

Browser usage requires **Node.js 22.19 or later** and npm. Check `node --version`. If Pi is missing, the launcher installs the official `@earendil-works/pi-coding-agent` through npm. An existing Pi must be **0.87.1 or later** and is not automatically replaced. Check `pi --version`.

Desktop packages include their runtime: do not install global Node/Pi just for desktop; read the [desktop guide](./desktop). Downloads, Pi installation, and model requests require access to the corresponding networks.

## 2. Open the Web interface

Run this in the directory you want to use as your workspace:

```bash
npx pi-webapp
```

On a local graphical desktop, the default browser opens and Pi stays in the background. Headless environments print a local address; it is not a public URL. Running the launcher again reopens the existing service rather than starting a service for every terminal.

Optional global installation:

```bash
npm install -g pi-webapp
pi-webapp
```

For remote usage, use a secure, privately managed local tunnel rather than exposing a listening port or sharing the token. Never publish the forwarded URL. See [security](./security).

## 3. Configure a model and send a first message

1. Open **Settings → Models**. Initial setup also leads to this page.
2. Choose a provider/model you are entitled to use and add authentication or sign in using the supported UI. Browser sign-in opens the provider page. If its callback cannot reach the Pi machine, use manual code entry when prompted. Never send API keys in chat.
3. Return to the conversation and select a workspace in the sidebar. Add another workspace if needed, verify its path, then create a session. Also verify the current workspace when using the launch directory.
4. Select an available model and send a read-only first message, such as “Explain how you can help me; do not modify any files yet.”
5. A completed streaming reply without an authentication error confirms the first conversation. Define scope and allowed actions before asking for file changes.

No reply? Check [troubleshooting](./troubleshooting) for authentication, version, and service checks instead of repeatedly submitting the task.

## 4. Status and stop

```bash
npx pi-webapp status
npx pi-webapp stop
```

After a global installation use `pi-webapp status` / `pi-webapp stop`. **Stopping the service ends background tasks across chats and service-owned terminals.** Finish active work first. Closing the page does not stop the service.

## Alternative: an existing Pi terminal

```bash
pi install npm:pi-webapp
pi
```

Enter `/web` inside Pi. The browser stays synchronized with that terminal session. Its random URL token lasts only for the current process; enter `/web` again to reopen it. Exiting that Pi process ends this service. Background-launcher stop and web-update procedures do not apply to this mode.

Next: [sessions](./sessions) · [model configuration](./configuration) · [updates](./updates)
