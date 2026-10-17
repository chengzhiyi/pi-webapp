# ADR-005: Staging, commits and local branch actions

Status: Accepted

Date: 2026-10-17

## Decision

Extend the existing Changes tab with per-file stage/unstage buttons, a fixed, compact staged-only commit composer and an on-demand local branch picker. Reuse existing design tokens and Dock/session models. Draft commit messages, new branch names, checkout preference and operation results survive chat switches until the tab closes or the page reloads. File diffs and historical views remain read-only. No new dependencies are needed.

Allow one explicit action per request. There is no bulk add, amend, arbitrary Git command, network synchronization, forced checkout, automatic stash or discard operation. Branch creation starts at the current HEAD; users choose whether to switch afterward. An initial commit is required before creating branches. Ordinary configured hooks and signing remain active.

## Protocol and boundaries

Both routes use existing bearer authentication, JSON/origin checks and active-session selection:

- `POST /api/workspace/git/control`: `{sessionId}` → `GitControlState`, including a SHA-256 state version, staged count, dirty flag, blocked reason and at most 512 local branches with current/occupied markers.
- `POST /api/workspace/git/write`: `{sessionId, expected, action, path?, message?, branch?, checkout?}` → `{action, head}`. Action is a fixed union: `stage`, `unstage`, `commit`, `create-branch`, `switch-branch`.

A write rechecks its state version after all asynchronous preparation and checks session selection/agent state immediately before starting Git. A stale version returns 409 and never queues a later write. The version covers HEAD, branch, refs/worktree occupancy, index entries, working-tree statuses and changed-file stat metadata, plus operation/lock markers. Reads and output remain bounded; truncated status or excessive branches disable writes.

Staging only accepts literal individual files present in scoped status, including deleted files and final symlinks. Escaping parent symlinks, traversal, directories, submodules and unresolved conflicts are rejected. Unstage updates the index only; staged renames restore both names where they are in scope, and unborn repositories use index removal without deleting working files. Commits consume the existing index with the message on stdin (8 KB maximum), never `-a`. Commit and branch switch require the repository-root workspace. Creating a branch without switching is allowed in a subdirectory. Switching requires a globally clean worktree including untracked files, refuses branches occupied by other worktrees and uses `--no-overwrite-ignore` to preserve ignored files.

Commands use argument arrays without a shell, literal pathspecs, validated local branch names and the existing sanitized Git environment. Command stderr and commit/hook contents never enter HTTP errors or telemetry. A finite reason code provides localized feedback. A nonzero hook/signing result is reported as failure with a request to check repository state. A timeout or uncertain network response reports an unknown outcome. Neither the backend nor browser retries writes. Drafts only clear after acknowledged success.

## Coordination and completion

The bridge checks the selected chat and all retained running chats whose canonical cwd overlaps the worktree. A process-local lease on the common Git directory serializes writes across linked worktrees and excludes Web message, resume and plugin entry points while a mutation is running. Starts reject rather than queue. Git discovery is optional for agent starts, so missing/non-Git/Git-unavailable workspaces retain their previous behavior; discovery is strict for writes.

Once a Git subprocess has started, changing the foreground chat cannot undo it. The response acknowledges completion in the original chat rather than returning a misleading post-write session conflict. Models retain pending/result state across unmounts. A completion event refreshes other visible Git views; hidden views refresh on activation. Reads may be aborted on cleanup; write requests are not treated as cancellable mutations.

The lease covers this server's Web entry points. External terminals, editors and independently started TUI turns can still change files or refs. Snapshot checks plus normal Git index/ref locks narrow those races; they are not a filesystem transaction against external processes. Git filters/hooks can run configured programs, as in terminal Git. This feature does not claim isolation from those processes or bypass their configuration.

## Verification

Temporary real repositories cover unborn indexes, literal/Unicode filenames, staged versus working content, stale snapshots, hook failure, root/subdirectory boundaries, parent symlinks, renames/deletions, operation markers, Git locks, ignored-file preservation, invalid/duplicate/occupied branches, write/start leases, authenticated HTTP boundaries and foreground chat changes during a running commit hook. Existing non-Git send/resume/plugin behavior is included in regression tests.

Real Chrome tests cover stage/unstage, commit body preservation, draft retention, stale-state recovery, background chat blocking, branch creation with and without checkout, duplicate branch feedback, lost commit responses without retry, history refresh, keyboard activation and light/dark layouts at 1440, 768, 390 and 320 px. All mutations occur in disposable repositories; verification never stages or commits project source changes.

## Compact layout refinement

Following user feedback about form density, the Changes tab now places files directly below a single repository row. Only the changed-file region scrolls; the compact composer remains at the bottom and expands while editing. In a subdirectory, a single root-workspace explanation replaces its unusable commit form. Ctrl/Cmd+Enter submits only when the staged/message/idle checks allow it and does not submit during IME composition.

The branch-name button opens the existing shared menu material with the existing modal keyboard layer. Search and local branch choices are shown first; an explicit New branch action opens the only creation form. Escape, outside pointer interaction, successful actions and view changes close it, and keyboard focus returns to its invoking control. Draft retention and backend policies remain unchanged. See [the design brief](../../.design/git-panel-compact/DESIGN_BRIEF.md) and its screenshot review for the layout acceptance criteria.
