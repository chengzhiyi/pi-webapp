# ADR-002: Read-only workspace Git review

Status: Accepted

Date: 2026-10-17

## Context and decision

Users need to inspect actual workspace changes alongside an agent conversation. Reuse the existing DockKit right sidebar, session selection, bearer/origin authentication and HTTP bridge. Add a built-in Git entry and separate unified-diff tabs, rather than a second application or a Git implementation in the browser. The backend calls the system Git without a shell; no new dependencies are required.

## Scope and ownership

Git changes belong to a working tree, while panel tabs belong to a chat. Chats using the same directory see the same changes; the UI calls these workspace changes and does not attribute them to the current agent turn. Detect repositories through Git, including `.git` files in linked worktrees, unborn branches and detached HEAD.

Only files within the selected session directory are listed and diffed. The repository root and directory scope are displayed explicitly. A subdirectory workspace does not grant access to sibling source contents. Rename sources are included only when inside the same scope; diffs disable rename detection and show scoped deletion/addition patches. Submodules and unresolved conflicts display notices rather than attempting recursive or combined-diff rendering.

## Protocol and limits

- `POST /api/workspace/git/status` accepts `{ sessionId }` and returns the shared `WorkspaceGitStatus` union. Status uses NUL-delimited porcelain v2; upstream divergence reflects local refs, without fetching.
- `POST /api/workspace/git/diff` accepts `{ sessionId, path, area }`, with a workspace-relative literal path and `area` of `staged`, `unstaged` or `untracked`. It returns the `WorkspaceGitDiff` union. Only paths in the current status listing can be read. Untracked text is rendered as an addition using the existing bounded workspace-file reader.
- Both routes check the active session before and after asynchronous work. Git errors return safe messages and are classified as content operations for telemetry; source, patches, repository paths and child-process stderr are never attached to error reporting.
- Limit listings to 1,000 entries, Git status output to 2 MiB, patches to 512 KiB / 10,000 lines, and each subprocess to 10 seconds. Large output is rejected rather than parsed partially. Disable inherited `GIT_*` redirections, optional index writes, filesystem monitor hooks, external diff drivers and text conversion helpers.

## Refresh and lifecycle

Visible tabs refresh immediately on opening, agent idle-state changes (including completion), focus and page visibility restoration. A five-second poll covers edits from terminals, other chats and external editors. Requests never overlap within a tab, and hidden tabs/pages do not poll. Effect cleanup aborts pending requests and discards late results on tab, scope or session changes. No filesystem watchers or persistent Git process is needed.

## Verification

Real temporary repositories cover staged/unstaged differences, filenames with spaces/newlines/Chinese/pathspec syntax, unborn and detached HEAD, linked worktrees, subdirectory boundaries, renames, deletions, conflict status, binary/large files and disabled external helpers. Bridge tests cover authentication, origin, input validation, read-only behavior and selection races. Browser tests exercise both themes, narrow layouts, keyboard access, automatic/manual refresh, split/fullscreen, hidden-tab polling and chat switching.

History graphs and write operations are outside this increment. Adding commit, checkout or remote actions later requires handling agents and other chats that share the same working tree.
