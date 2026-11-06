# Security and privacy

This page explains what pi-webapp can and cannot protect, where your data lives, what leaves your machine, and how to use it safely.

## The short version

- The service listens on your own machine only (`127.0.0.1`) and requires a random access token that is in the address you open.
- **It is not a sandbox.** The agent and every terminal run with your user's permissions and can read, change and delete whatever you can.
- Your credentials and chat history stay in Pi's data folder on your disk.
- Messages and attachments go to the model provider you chose. By default nothing else is sent anywhere, and error reporting is off.

## Network exposure and the access token

When it starts, the service binds `127.0.0.1` on a random free port. It does not listen on your network interfaces, so other machines can't reach it directly. The address it prints looks like this:

```text
http://127.0.0.1:52395/#im0P2eSzuw1xH6Vmhr2Z2hjpLoy8I8qy
```

The part after `#` is a random 192-bit token. The page reads it and sends it as a bearer token with every request to the service's `/api/` routes. A request without a valid token is rejected with HTTP 401, and modifying requests from another web origin are rejected too. The page itself is served with a strict content security policy: scripts and styles only from the service, no framing by other sites.

What that means in practice:

- **Treat the full address as a password.** Anyone who has it, and can reach that port, can drive your agent and your terminals. Don't paste it into chat, tickets or screenshots of your address bar.
- The address ends up in your browser history and bookmarks. On a shared computer, use a private window or clear it.
- Other users on the same machine can connect to the port but can't use it without the token. The launcher stores the address in a file only your user can read (`pi-web/launcher.json`).
- The token changes every time the service restarts, with one exception: an in-app **Update and restart** keeps the old port and token so your page reconnects. A `/web` token lasts only as long as that Pi process.

### Remote machines {#remote-machines}

Never bind or proxy the service to a public address, and never publish the forwarded URL. To use a service that runs on another machine, forward its port through a private channel such as SSH, and **use the same port number on both ends**:

```bash
# On the remote machine: find the port
npx pi-webapp status
# On your own computer: forward that exact port (52395 in this example)
ssh -L 52395:127.0.0.1:52395 you@remote-host
```

Then open the full address, with its token, in your local browser.

The same port number matters because the service only accepts requests whose origin is exactly the address it printed. If you forward to a different local port, the page loads but shows **来源不匹配** ("origin mismatch") and live features fail. Over SSH the launcher doesn't try to open a browser, and **Add workspace** uses pi-webapp's own folder browser instead of a native one.

## What the agent and terminal can do

- **The agent** can read, create, edit and delete files, and run shell commands, anywhere your user can. Choosing a workspace sets where it starts, not where it may go.
- **Terminals** are your login shell. The workspace is only the starting folder. The agent can read the current chat's terminals, and types into one only after you allow that exact command.
- **File previews** are narrower than that: they read only inside the workspace and don't follow symlinks out of it. That limits the preview tool, not the agent.
- **Git writes** (commit, branch switch) check for stale state and wait for chats that share the working tree to be idle. They are guardrails against mistakes, not access control.

Practical habits:

- Start the service from a project folder, not from your home directory.
- Ask for a plan or a read-only explanation before you allow changes, and review diffs in the [Git tool](./workspace-tools#git) before committing.
- Keep work you can't afford to lose under version control.
- Don't point it at a folder that holds secrets you wouldn't paste into the model provider yourself.

## Where your data lives

Everything is under Pi's data folder, `~/.pi/agent` by default ([`PI_CODING_AGENT_DIR`](./reference/environment) changes it). See [Files and directories](./reference/files) for the full map.

| What | Where | Notes |
| --- | --- | --- |
| Sessions | `sessions/` | Full conversation history, including tool output. |
| Credentials | `auth.json` | Readable by your user only. Never returned to the browser. Never attach it to a report. |
| Model configuration | `models.json` | No keys, but may contain private URLs. |
| pi-webapp state | `pi-web/` | Workspace list, uploaded attachments, plugin data, launcher state and log. |

Attachments you upload are copied under `pi-web/attachments/`. Removing a workspace from the sidebar deletes none of this.

## What leaves your machine

| What | To whom | When |
| --- | --- | --- |
| Your messages, tool output, attached files | Your model provider | Every request. They follow that provider's data policy. |
| Package and release downloads | The npm registry, GitHub | When you start with `npx`, check for or install an update, or download a plugin such as Excalidraw. |
| Error reports | Sentry | **Never, unless you turn them on.** |

A local web page does not mean local inference. If you need nothing to leave the machine, point a custom provider at a model server that runs on it ([Models and providers](./models#custom-provider)).

### Error reporting

Sentry error reporting is **off by default**. A configured destination (DSN) alone doesn't enable it; it needs `PI_WEB_SENTRY_ENABLED=true` in the environment of the process that starts the service. If you never set that, nothing is reported, and you don't have to set anything to stay opted out.

When enabled, reports are limited to sanitized stack traces, event breadcrumbs and state summaries. Conversations, file contents, attachments, credentials, request bodies and session recordings are not collected on purpose, but arbitrary error text can't be classified perfectly, so keep private data out of error messages. The details are in the [Sentry notes](https://github.com/chengzhiyi/pi-webapp/blob/main/docs/sentry.md).

If you ever set it and want it off again, unset the variable or set it to `false`, then [restart the service](./reference/environment#changing-the-environment).

## Plugins, packages and extensions

- **Pi packages, extensions and skills** run with the same permissions as Pi. Install only from sources you trust, as you would with any code you run on your machine.
- **Optional plugins** such as Excalidraw come from npm as verified packages. They run in a separate Node.js process and their pages in a separate browser frame, which separates their lifecycle from the main page. That is **not a hostile-code sandbox**.
- Excalidraw runs entirely locally, with no Excalidraw cloud service, collaboration or upload.

## Report a vulnerability or a bug safely

Open an [issue](https://github.com/chengzhiyi/pi-webapp/issues) for ordinary bugs. Don't post tokens, access URLs, `auth.json`, private keys or private conversations in a public issue; reduce the problem to a minimal example first. This project doesn't publish a private security contact yet, so for a vulnerability that would be dangerous to disclose publicly, open an issue that describes the area but leaves out the exploit details and asks for a private channel.
