# Files, terminal and Git

This page shows how to use the three built-in tools next to a conversation: preview files, run commands in a real terminal, and review and commit changes.

## Open the tool panel

Click the panel icon in the upper right of a conversation to open the right sidebar. Its start page offers three tools:

![The tool panel start page with Workspace files, Open terminal and Git changes](/images/tool-panel-start.png)

Each tool opens in a tab. Use the **+** at the end of the tab bar to open more, **Split** to place two tools side by side, and **Fullscreen** to give the panel the whole window. Every chat keeps its own tabs while the page stays open; reloading the page resets them.

If you install the [Excalidraw](./diagrams) or [OpenPencil](./design) plugin, its entry appears on the same start page.

## Files {#files}

Choose **Workspace files** to browse the workspace. The folder tree sits on the right; click a file and its preview opens on the left of the same tab. The path above the preview is clickable: choose any folder in it to list that folder's contents and jump to another file. Use the panel button at the end of the toolbar to hide or show the tree. In a narrow panel the tree and the preview take turns. File links the agent writes in chat (paths inside the workspace) open the preview in its own tab, with the same clickable path.

![A file open in a read-only preview tab](/images/files-preview.png)

| File type | Preview |
| --- | --- |
| Code and text | Syntax highlighting with line numbers. |
| Markdown | Switch between a rendered view and the source. |
| PNG, JPEG, GIF, WebP | An image you can open full size. |
| HTML and SVG | Shown as source text. They are never run. |
| Other binary files | A notice that they can't be previewed. |

Limits: up to 1,000 entries per folder, 5 MB or 200,000 lines of text, and 8 MB per image. The previewer only reads inside the workspace and follows no symlink that leads outside it. The tree, its Git colours and any preview you aren't editing reload when the agent finishes a turn; use the refresh buttons to reload them at other times.

**Search.** Type in the box above the tree to filter files by name (letters in order also match, so `btx` finds `button.tsx`). Start with `?` to search inside files instead, for example `?TODO`; choose a match to open the file at that line. In a Git repository both searches skip ignored files; elsewhere they skip `node_modules`. Press Esc to clear the search.

**Git status.** In a Git repository, changed files and the folders that contain them are coloured and marked with a dot: amber for modified, green for new or untracked, red for conflicts. Ignored files and folders are greyed out.

**Editing.** Code and text files open straight in an editor with syntax highlighting, line numbers, undo, and find (⌘/Ctrl+F; Enter and Shift+Enter step through matches, Esc closes). Markdown opens rendered; choose **Edit** to change the source and **Preview** to see your unsaved edits rendered. Choose **Save** or press ⌘/Ctrl+S. Tab indents; press Esc and then Tab to move focus out of the editor. Saving only overwrites an existing file and keeps its line endings. If the file changed on disk while you were editing (for example because the agent edited it), the save stops and you choose whether to discard your edits and reload, or overwrite. You're asked before leaving a file with unsaved changes. Images and binary files stay read-only.

## Terminal {#terminal}

Choose **Open terminal** for an interactive shell that starts in the workspace folder.

![A terminal tab after running npm test](/images/terminal.png)

- The shell is your login shell (`$SHELL`, falling back to `/bin/sh`), started interactively. On Windows it is `%COMSPEC%`, usually `cmd.exe`. If that program is missing or not executable, the terminal reports an error and you fix `SHELL` (or `COMSPEC`) and restart the service.
- Typing, **Ctrl+C**, resizing and full-screen programs work as in a normal terminal. Each terminal keeps 2,000 lines of scrollback.
- Switching tabs or chats, or collapsing the sidebar, keeps the process running. A short browser disconnect reconnects without replaying uncertain input; a browser that stays away for more than five minutes loses its hold on the terminal.
- You can have 8 terminals per chat and 32 per service.
- Closing a terminal tab, or stopping the service, ends its process. Reloading the page doesn't bring tabs back, and restarting the service doesn't bring processes back.
- You can ask Pi to run something in a terminal ("run the tests in this terminal"). Pi can read a terminal's recent text (up to 500 lines) on its own, but before it types anything it shows the exact command, on the terminal and in place of the message box, and waits for you to choose **Allow** or **Deny**. Every command needs its own approval. Pi only sees and types into the current chat's terminals.

::: warning The terminal is not sandboxed
Commands run with your user's permissions. The workspace is only the starting folder. Check what you paste before you run it.
:::

## Git {#git}

Choose **Git changes**. Git must be installed on the machine running the service.

![The Git tool showing a one-line diff](/images/git-diff.png)

**Changes** lists unstaged, staged and untracked files (up to 1,000). Click a file to see its diff beside the list, and step through change blocks with the arrows. Diffs over 512 KB or 10,000 lines, binary files, submodules and conflicted files may show only a notice.

Things you can do:

| Task | How |
| --- | --- |
| Stage or unstage | The **+** or **−** at the end of a file row. |
| Commit | Type a message in the box at the bottom and click **Commit**, or press **Ctrl/Cmd+Enter**. Only the staged files are committed. Hooks and signing configured in Git are honored. |
| Switch or create a local branch | Click the branch name at the top; search the list or choose **New branch**. |
| Browse history | The **History** tab loads 50 commits at a time with commit details, including merge-parent comparisons. |

Pushing, fetching, stashing and discarding changes are **not** available here; use the terminal tab for those.

::: warning Writes affect everything in the working tree
Commits and branch switches need the workspace's root folder. Switching branches also needs a clean tree, untracked files included. All chats that share the working tree must be idle first. A stale view, a lock file, an unresolved conflict, a Git operation already in progress, or a branch that another worktree has checked out all block a write. A failed or uncertain write is never retried automatically.
:::

Remote branch labels and ahead/behind counts come from what Git already knows locally; pi-webapp never fetches.

## Turn a tool off

Files, Terminal and Git can each be switched off under **Plugins** in the sidebar. See [Packages, skills and plugins](./extensions#built-in-capabilities). Turning Terminal off ends every terminal on the service.

Next: [Diagrams with Excalidraw](./diagrams).
