# Overview & entry points

pi-webapp is a local browser and desktop interface for the Pi coding agent. Pi still runs the agent, tools, and session storage; this is not a replacement agent service.

::: warning Development documentation
These pages follow the source tree; the source manifest version appears in the footer. npm latest and public hosting have not been verified. Your installed version may differ. Web usage requires Node.js ≥ 22.19 and an existing Pi ≥ 0.87.1; desktop uses its bundled runtime.
:::

| Entry point | Best for | Lifetime |
| --- | --- | --- |
| `npx pi-webapp` / global command | Direct browser use; recommended | Pi runs in the background; closing the browser does not stop tasks. Use `status` / `stop`. |
| `/web` inside an existing Pi terminal | Existing Pi terminal users | Bound to that Pi process; exiting it ends the service. |
| pi desktop test build | Opt-in macOS arm64 testers | Bundles Node/Pi, can reuse a compatible backend, and offers background-task choices on exit. |

Start with [installation and a first conversation](./getting-started). Already running? Read [sessions](./sessions), [workspace tools](./workspace-tools), or [troubleshooting](./troubleshooting). Read [desktop test limits](./desktop) before downloading.

## Important boundaries

- Chats run independently; switching chats is not stopping them.
- Terminals and the agent use your system permissions, not a sandbox. Git changes belong to a shared worktree.
- Local URLs contain access tokens: do not share them. Sentry error reporting is on by default and can be disabled. See [security and privacy](./security).
