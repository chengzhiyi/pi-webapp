# Files and directories

This page maps where pi-webapp and Pi keep data on disk, which files are sensitive, and what to back up.

## The data folder

Everything lives under Pi's data folder, `~/.pi/agent` on macOS and Linux and `%USERPROFILE%\.pi\agent` on Windows. [`PI_CODING_AGENT_DIR`](./environment) moves it. The paths below are relative to it.

```text
~/.pi/agent/
├── auth.json                   credentials
├── models.json                 custom providers and model settings
├── models-store.json           managed by Pi
├── settings.json               Pi settings, including packages and skills
├── sessions/
│   └── --Users-you-projects-my-app--/
│       └── 2026-11-01T10-28-05-873Z_<id>.jsonl
└── pi-web/                     pi-webapp's own state
    ├── launcher.json
    ├── launcher.log
    ├── workspaces.json
    ├── trash/
    ├── plugins.json
    ├── attachments/
    ├── hosted/
    └── releases/
```

| Path | Contents | Sensitive? |
| --- | --- | --- |
| `auth.json` | API keys and sign-in tokens. Mode `600` (your user only). | **Yes. Never share.** |
| `models.json` | Custom providers and per-model settings. No keys. | Maybe: it can contain private URLs. |
| `models-store.json` | Model data managed by Pi. Leave it alone. | No |
| `settings.json` | Pi's global settings, including packages, extensions and skills you added. Created when needed. | Low |
| `sessions/<workspace>/<time>_<id>.jsonl` | One file per saved chat, in JSON Lines: messages, tool calls and results. The folder name is the workspace path with `/` replaced by `-`. | **Yes**: your whole conversation. |
| `pi-web/launcher.json` | State of the running service: PID, version and the **full address with its access token**. Mode `600`. Removed on a clean stop. | **Yes. Never share.** |
| `pi-web/launcher.log` | Append-only log of launcher events, one JSON object per line. Mode `600`. | Review before sharing. |
| `pi-web/workspaces.json` | The workspace list, and workspaces you hid. | Reveals project paths. |
| `pi-web/trash/` | Chats you deleted in the sidebar, moved here with a timestamp prefix instead of being erased. Move a file back under `sessions/` to restore it. | **Yes** |
| `pi-web/plugins.json` | Which built-in tools are switched on or off. Created when you change a switch. | No |
| `pi-web/attachments/` | Files you uploaded in chats. | **Yes** |
| `pi-web/hosted/` | Downloaded plugins (such as Excalidraw and OpenPencil), their data, and their policies. | Drawing and design data may be sensitive. |
| `pi-web/diagrams/` | Original data of drawings made before Excalidraw became a plugin. Kept after migration. | Maybe |
| `pi-web/releases/`, `update.json`, `update-preferences.json` | Releases downloaded by **Update and restart**, which one is selected, and your Stable/Preview choice. | No |
| `pi-web/launcher.stop`, `launcher.restart` | Short-lived request files used to stop or restart the service. You may see them for a moment. | No |

Project-local Pi settings, such as packages installed with `pi install -l`, are kept inside the project at `.pi/settings.json`.

## What to back up

To keep your work, copy `sessions/`, `auth.json`, `models.json`, `settings.json`, `pi-web/workspaces.json` and `pi-web/hosted/`. Stop the service first so nothing is mid-write. Treat the copy like a password store.

## What you can safely delete

- A single chat: use **Delete chat** in the sidebar, which moves it to `pi-web/trash/`. Delete the file there to erase it for good.
- `pi-web/` as a whole: only if you accept forgetting workspaces, attachments, downloaded plugins and update state. Your sessions and credentials are outside it.
- **Don't** delete the whole data folder, `pi-web/releases/` or `pi-web/hosted/` by hand to "fix" a problem; see [Troubleshooting](../troubleshooting).

## On the desktop app

The desktop app uses the same data folder. **窗口 → 打开日志目录** (Window → Open log folder) opens `pi-web/`, which contains `launcher.log`.
