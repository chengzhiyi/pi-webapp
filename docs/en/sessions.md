# Sessions and workspaces

This page explains how pi-webapp organizes chats by project, how to add and remove projects, and what survives switching, reloading and restarting.

## The two ideas

- A **workspace** is a project folder. It is where the agent starts, and it groups your chats in the sidebar.
- A **session** is one chat with Pi inside a workspace. Pi saves each session as a file, so it survives restarts.

A workspace is not a permission boundary. The agent and terminal can reach anything your user account can; see [Security and privacy](./security).

## Start and switch chats

- **New session** (top of the sidebar) starts a chat in the current workspace.
- The **+** next to a workspace name starts a chat in that specific workspace.
- Click any chat under a workspace to open it. Chats are listed newest first, with a relative time such as `now` or `2min` and a state of **Running** or **Idle**.
- The search icon next to **Workspaces** searches chats by name and workspaces by path.

A new chat is named after your first message. Until you send one, it shows a placeholder title (currently in Chinese).

Chats run independently. Switching to another chat, workspace or page does not stop one that is working: when you return, its output, history and any waiting interaction are there.

## Add and remove workspaces

When the service starts it adds the folder you launched it from, and it picks up every folder that has saved Pi sessions, including chats you started earlier in the Pi terminal.

To add another project, click the folder icon next to **Workspaces** (**Add workspace**):

| Where you run pi-webapp | What opens |
| --- | --- |
| macOS | The system folder chooser |
| Linux with a desktop and `zenity` or `kdialog` installed | The system folder chooser |
| Windows, an SSH session, or a machine without a desktop | pi-webapp's own folder browser, which can also create a new folder |

To remove one, open **Workspace actions** next to its name and choose **Remove workspace from list**. The current workspace can't be removed; the menu says **Switch to another workspace before removing**.

Removing a workspace only hides it. **It does not delete files or sessions.** Add the folder again to bring it back.

::: warning Running `npx pi-webapp` from another folder doesn't add it
If the service is already running, the command only prints and reopens the existing address. Use **Add workspace**.
:::

## What survives what

| Action | Result |
| --- | --- |
| Switch chats or workspaces, or start a new chat | Other chats keep running. |
| Close the browser tab | The service and every chat keep running. |
| Reload the page | The backend is untouched. Open tool tabs (files, terminals, Git) are reset to their start state. |
| **Pause** a chat | Only that chat pauses ([Conversations](./conversation#pause-and-continue)). |
| Stop or restart the service | Running chats and every terminal end. Saved history stays, but a task that was running is not resumed. |

## Where sessions live

Pi stores each session as a JSON Lines file under its data folder, grouped by workspace path:

```text
~/.pi/agent/sessions/--Users-you-projects-my-app--/2026-11-01T10-28-05-873Z_01a196a6-f271-75c0-8cb5-7a0839f57917.jsonl
```

The folder name is the workspace path with `/` replaced by `-`. pi-webapp has no rename or delete for sessions. To remove one, stop the service and delete its file. Never delete the whole `~/.pi` folder to fix the sidebar: it also holds your credentials and settings ([Files and directories](./reference/files)).

## Several chats in one project

Chats in the same workspace share one working tree. Two chats can edit the same files, and the Git panel shows all changes together, not just one chat's. Before you commit or switch branches, make sure related chats are idle ([Files, terminal and Git](./workspace-tools#git)).

Chats in a workspace other than the one the service was launched from run through Pi's SDK and use that workspace's own skills and project context. Not every extension you installed for the terminal is necessarily loaded in each chat.

Next: [Files, terminal and Git](./workspace-tools).
