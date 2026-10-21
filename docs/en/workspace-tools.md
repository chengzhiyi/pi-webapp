# Files, terminal & Git

Open the right sidebar using the permanent control in the conversation's upper-right corner. On its start page choose **Workspace files**, **Open terminal**, or **Git changes**. Tools support tabs, resizing, split panes, and fullscreen. **Plugins**, below New session in the main sidebar, globally controls bundled capabilities; there is **no duplicate plugin switch in Settings**.

## Workspace files

Browse directories and open read-only previews; in-workspace path links in chat also open previews. Code has highlighting and line numbers, Markdown offers preview/source views, and PNG/JPEG/GIF/WebP support a lightbox. HTML/SVG remain source text, not executable previews.

Limits: 1,000 entries per directory, text 512 KB / 10,000 lines, images 8 MB. Unsupported binaries show a notice. Reads and resolved symlink targets stay within the session workspace. Refresh listings/previews manually. Switching chats retains tabs; reloading resets them.

## Terminal

Starts your default shell with the workspace as its initial directory. Interactive input, Ctrl+C, and resizing are supported. Switching tabs/chats or collapsing the sidebar retains processes; short disconnects reconnect without replaying uncertain input.

- At most 8 terminals per session, 32 per service, with 2,000 scrollback rows.
- Closing a terminal tab or stopping the service reaps its process. Disconnected browsers have a five-minute retention window. Page reload does not restore tabs; service restarts do not restore processes.
- **Shells run with the Pi user's system permissions. The workspace is not a shell sandbox.** Check paths and side effects before executing commands.

## Git changes and history

Git must be installed on the Pi machine. Lists show up to 1,000 files; diffs up to 512 KB / 10,000 lines. The list and read-only preview stay in one panel, with previous/next change-block navigation. Binaries, submodules, and conflicts may show notices only. History loads 50 commits at a time and supports commit details and merge-parent comparisons. Remote labels/divergence use local records without fetching.

In **Changes**, use each file's **+ / −** to stage/unstage. The bottom composer commits only the staged index and supports Ctrl/Cmd+Enter. Click the branch name to search/switch local branches or choose **New branch**.

::: warning Writes are shared
Commits and branch switches require a root workspace; switching also requires a clean worktree, including untracked files. All known chats sharing it must be idle. Stale snapshots, locks, conflicts, ongoing Git operations, and occupied worktree branches can block writes. Hooks/signing are honored. Failed or uncertain operations never retry automatically. There is no push, fetch, forced switch, stash, or discard.
:::

Read-only preview scope is not a permission sandbox for shells or Git. Disabling the Terminal plugin requires confirmation and ends all service-owned terminals; it is not a substitute for closing one tab.
