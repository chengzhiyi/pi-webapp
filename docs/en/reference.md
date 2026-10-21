# Configuration & versions

This page lists verified user-facing settings, not every internal `PI_WEBAPP_*` control as a public API. Environment changes require restarting the actual Pi backend; reopening an existing service does not apply a new environment.

| Setting | Purpose |
| --- | --- |
| `PI_WEBAPP_AUTO_OPEN=0` | Disable automatic browser opening; the local address remains available. |
| `PI_CODING_AGENT_DIR` | Change Pi's agent data root (default `~/.pi/agent`); Web data lives under its `pi-web/`. Understand migration consequences before changing it. |
| `PI_WEB_SENTRY_ENABLED=false` | Disable error reporting on both sides; see [security](./security). |
| `PI_WEB_SENTRY_DSN` | Replace the built-in public destination; see the [detailed topic](https://github.com/chengzhiyi/pi-webapp/blob/main/docs/sentry.md). |

Prefer **Settings → Models** for provider authentication/model configuration; never attach configuration contents to reports. Plugin-development settings belong in [developer resources](./resources).

## Version boundaries

- This is **development documentation**. The footer reads the root `package.json`, not npm latest.
- Web requires Node.js ≥ **22.19.0** and existing Pi ≥ **0.87.1**. Pi, pi-webapp, the external protocol package, and desktop build numbers are different version dimensions.
- A managed npm runtime update may differ from the global package version. Check the actual running version.
- Desktop: only macOS arm64 has validated test downloads. The new signature process from **build 7 onward** neither repairs old downloads nor adds a publisher identity.
- No multi-version snapshots are provided yet. For older installs, use the README/source at the corresponding release commit. Stable-site release provenance and public hosting still require separate phase-B verification.

## Common commands

```bash
npx pi-webapp          # Start or reopen
npx pi-webapp status   # Status / local address (never share the token)
npx pi-webapp stop     # Ends background tasks; finish work first
```

See [updates](./updates) for source and `/web` differences. Documentation builds are independent of the product service; a documentation outage must not affect the agent.
