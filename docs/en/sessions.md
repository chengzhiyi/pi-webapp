# Sessions & workspaces

A workspace is the directory used by a session, not a permission sandbox. Startup discovers workspaces from Pi's saved sessions, including conversations previously created in other directories.

## Common actions

- Select a workspace and saved conversation in the sidebar, or create a session.
- Adding a workspace uses a native directory picker when available; SSH environments can use the built-in directory browser.
- Removing a workspace from the sidebar **does not delete its files or sessions**. Add it manually to display it again.
- Workspace records and attachments live under `pi-web/` in Pi's data directory. See [configuration](./reference) for a custom data root. Do not delete the Pi data directory to repair the sidebar.

## Switching, reloading, and restarting

| Action | Effect |
| --- | --- |
| Switch chats/workspaces or create a chat | Existing chats keep running. Returning restores output, history, and pending plugin interactions. |
| Pause a chat | Affects only the selected chat, not the service. See [controls](./conversation). |
| Reload the page | Does not reload the backend. File/tool tabs reset; do not rely on it to restore terminals. |
| Stop/restart Pi | In-memory sessions and background tasks end. Terminals do not survive restart. Saved history is not a still-running task. |

Chats in other workspaces use the Pi SDK and load that workspace's skills and project context. Enabled Web-plugin Pi entries are loaded explicitly; other ordinary extensions remain isolated from the parent bridge. Do not assume identical extension environments in every chat.

Several chats can operate on one worktree. Before Git writes, ensure related chats are idle and check the origin of changes: the file list is not a record of changes exclusively made by the selected chat.
