# FAQ

Short answers to common questions, with links to the page that explains each in full.

## General

### Does pi-webapp replace Pi?

No. Pi runs the agent, calls the model, executes tools and stores the sessions. pi-webapp is the interface around it. Your Pi sessions, models, skills and extensions carry over. See the [introduction](./introduction).

### Is it free? Do I need an account?

pi-webapp is open source under the MIT license and has no account of its own. Model usage is billed by the provider you connect, and you need a credential for it ([Models and providers](./models)). The optional Excalidraw plugin needs no account either.

### Does it work offline?

The interface itself runs on your machine, but the first start downloads packages from npm, and the agent needs a model. If you point a custom provider at a model server on your own machine, no conversation data leaves it ([Models and providers](./models#custom-provider)).

### Which operating systems work?

The web launcher needs Node.js 22.19 or later. Desktop installers are published for macOS (Apple Silicon and Intel), Windows x64 and Linux x64 ([Desktop app](./desktop)). Windows ARM and Linux ARM aren't covered.

### Why are the command-line messages in Chinese?

The launcher's text isn't localized yet. [The reference](./reference/cli#messages) translates every message. The browser interface is localized: **Pi Settings → General → Language** switches between English and Chinese, and by default follows your browser language.

## Running it

### Does closing the browser tab stop the agent?

No. In the web launcher and the desktop app's shared service, the service and its chats keep running. Run `npx pi-webapp status` to see whether it is up and `npx pi-webapp stop` to end it. Stopping ends all running chats and terminals ([Quick start](./getting-started#_6-stop-it-and-start-it-again)).

### Why did the address change after I restarted?

The port and token are random each time the service starts. An **Update and restart** from Settings is the exception: it keeps both so the page reconnects. Open the current address with `npx pi-webapp status`.

### Can I choose the port?

No. There is no setting for it; the service always takes a free port on `127.0.0.1`.

### Can I run more than one service?

One service runs per Pi data folder. To run another one on purpose, start it with a different `PI_CODING_AGENT_DIR`. It gets its own sessions, models and credentials, which is handy for a clean test ([Environment variables](./reference/environment)).

### Can I open it from my phone or another computer?

Not directly: the service only listens on `127.0.0.1`. To reach one running on another machine, forward its port over SSH using the same port number ([Security → Remote machines](./security#remote-machines)). Don't expose it to the internet.

### Which Pi version does it use?

The npm package ships with an exact, tested Pi version and uses it for the service. It never changes a Pi you installed globally. In `/web` mode it runs inside your own Pi instead ([Use it from the Pi terminal](./use-from-pi)). The desktop app bundles its own.

### Can I use the web view and the Pi terminal on the same project?

Yes. They share Pi's saved sessions, so chats you started in the terminal appear in the web sidebar and the other way round. Avoid driving the same project from two places at once, because both can edit the same files.

## Your data

### Where are my chats stored? How do I delete one?

In `~/.pi/agent/sessions/`, one file per session ([Files and directories](./reference/files)). To remove a chat, use the **…** button on its row in the sidebar and choose **Delete chat**. The file moves to `pi-web/trash/` instead of being erased, so you can move it back to restore it ([Sessions and workspaces](./sessions#rename-or-delete-a-chat)).

### What happens to my files if I remove a workspace?

Nothing. It's only hidden from the sidebar. Add the folder again to bring it back ([Sessions and workspaces](./sessions#add-and-remove-workspaces)).

### Does pi-webapp send telemetry?

Not by default. Error reporting is off unless you set `PI_WEB_SENTRY_ENABLED=true`. Your messages go to the model provider you chose and to nobody else ([Security and privacy](./security#what-leaves-your-machine)).

### How do I uninstall it?

Stop the service first (`pi-webapp stop`). Then remove what you installed:

```bash
npm uninstall -g pi-webapp      # if you installed it globally
pi remove npm:pi-webapp         # if you installed it into Pi for /web
```

For the desktop app, delete **pi.app** (or run the Windows uninstaller). These steps leave your Pi data in place. pi-webapp's own state is the `pi-web/` folder inside the Pi data folder; delete it only if you want to forget workspaces, attachments, downloaded plugins and update state. Your sessions and credentials are outside it. Don't delete the whole `~/.pi` folder unless you want to lose them too.

## Agent and safety

### Can the agent push to GitHub or delete files?

The Git tool can't push, but the agent and the terminal run commands as you. If your shell is signed in to GitHub, the agent can run `git push`. Treat the agent as you would a colleague with your keyboard: use version control, review diffs, and keep secrets out of reach ([Security and privacy](./security)).

### Is the workspace a sandbox?

No. It is where the agent starts, not a boundary.

### Is it safe on a shared or remote machine?

The token protects the service, but anyone with the full address can use it, and other accounts on the machine can reach the port. Don't use it on a machine where you don't trust other users with your account's permissions ([Security and privacy](./security)).
