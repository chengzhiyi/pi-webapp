# Security & privacy

## Local service, not a permission sandbox

The local URL includes a random token. Possessing it may allow access to your local agent and tools. Never share token-bearing URLs, screenshots of addresses, or the full browser location. Do not expose the service directly to the public internet. A `/web` token is bound to the current Pi process.

Terminals run with the Pi user's permissions; the workspace is only their initial directory. Agent tools can also modify local files. Read-only file-preview scope does not make the whole application a sandbox. Git writes affect a shared worktree: check other chats and collaborators before acting.

## Credentials and model data

Provider credentials remain in Pi's local `auth.json`; model configuration is in `models.json`, not on the documentation site. Credentials are not returned to the browser. Never send them in chat, attach them to reports, or commit them. Conversations and attachments sent to a model follow your provider's data policy. A local UI does not imply offline inference.

## Default error collection (telemetry) and opt-out

**Browser and extension Sentry reporting is off by default.** Neither a built-in nor an overridden DSN enables it; reporting requires an explicit `PI_WEB_SENTRY_ENABLED=true` opt-in. Collection is limited to sanitized stacks, semantic breadcrumbs, and state summaries. Conversations, source bodies, attachments, credentials, request bodies, and session recordings are not deliberately collected. Arbitrary exception text cannot be classified perfectly; keep private data out of error messages.

Disable it in the **environment of the Pi/launcher process**:

```bash
PI_WEB_SENTRY_ENABLED=false npx pi-webapp
```

Windows PowerShell:

```powershell
$env:PI_WEB_SENTRY_ENABLED = 'false'
npx pi-webapp
```

If the backend already runs, finish tasks, stop it through its original entry point, then start with this environment. Reopening an existing service does not change its environment. For `/web`, set the variable before starting `pi`. Pi does not automatically read `.env`. A desktop backend must also inherit the setting; if desktop reuses an external backend, configure that external process rather than refreshing the window.

Use `PI_WEB_SENTRY_DSN` to change the destination. Per-side destinations and detailed collection boundaries remain in the [Sentry topic](https://github.com/chengzhiyi/pi-webapp/blob/main/docs/sentry.md). Remove an existing `PI_WEB_SENTRY_ENABLED=true` or set it to `false` to disable reporting; DSN settings alone cannot enable it. The documentation site uses local search; no third-party search or analytics service was added.

## Reporting safely

Do not post exploit tokens or private data in public Issues. Sanitize a minimal reproduction first. No unverified private security address or response-time promise is invented here. See [desktop testing](./desktop) for checksum/signature limits; never disable system protections globally.
