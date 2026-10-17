# ADR-004: Commit history and branch graph

Status: Accepted

Date: 2026-10-17

## Context and decision

Extend the read-only Git review in [ADR-002](002-workspace-git-review.md) with a History view and Dock tabs for commit details and per-file historical diffs. Reuse the shared Git command runner and diff renderer. Render a small SVG lane graph from actual parent OIDs; no graph library, repository writes, network access or new runtime dependencies are needed.

History spans local branches, remote-tracking refs, tags and the current HEAD. It uses topological order without path-based history simplification, so displayed edges preserve actual parent relationships. File lists and diffs remain restricted to the session directory; subdirectory workspaces display that distinction explicitly. Reference labels reflect local state, not a fresh remote fetch.

## Protocol

All requests use the existing bearer/origin checks and active-session validation before and after asynchronous reads. New routes are content operations in telemetry; commit messages, authors, email addresses, refs and patches are not reported.

- `POST /api/workspace/git/history`: `{ sessionId, limit?, cursor? }`. Defaults to 50 commits, maximum 100 per request. Returns `GitHistory`, with refs, HEAD, commits, actual parent OIDs, a snapshot fingerprint and a next-page cursor.
- `POST /api/workspace/git/commit-detail`: `{ sessionId, hash, parentIndex? }`. Returns `GitCommitDetail` with full message, author/committer metadata, parents and scoped file statuses/numstat. Defaults to the first parent.
- `POST /api/workspace/git/commit-diff`: `{ sessionId, hash, parentIndex?, path }`. Returns `GitCommitDiff` using the shared patch result union and explicit comparison-parent OID (null for a root commit).

Only full SHA-1/SHA-256 commit OIDs reachable from the visible refs or HEAD are accepted. Clients cannot send arbitrary revision expressions, hidden reflog objects, diff options or parent hashes. Parent indices are checked against the selected commit. Commit files are checked against the scoped detail listing before diffing. Root commits use Git's empty-tree comparison, including SHA-256 repositories; merges compare against exactly the chosen parent.

## Consistency and bounds

The cursor contains a reference snapshot fingerprint and offset, not client-provided graph tips. A reference/HEAD change returns 409 for an old cursor. The browser refreshes the first page, resets accumulated pages on a new fingerprint and disables further pagination while refreshing. Unchanged snapshots retain loaded pages and lane continuity. Traversal is bounded to roughly 10,000 commits, 512 refs, 1,000 files per detail, 2 MiB command output, 256 KiB commit metadata and 512 KiB / 10,000 lines per patch. Existing ten-second subprocess limits remain in effect.

The command runner removes inherited Git redirections and disables object replacements, optional index writes, pager/monitor hooks, external diff and text conversion. Commit diffs read committed objects, independently of current file contents. Snapshot cursors do not persist a server-side repository cache.

## Browser behavior

The Git tab retains its view, selected commit and accumulated pages in the session-owned Dock controller. Closing the tab clears its model. Visible history uses the existing refresh lifecycle; hidden history and inactive chats do not poll. Immutable detail/diff tabs refresh on open, focus, agent state changes or explicit refresh, without periodic polling. Async cleanup discards late responses. A parent selection hides the prior file listing until the chosen comparison arrives.

The graph carries active parent lanes across page boundaries, starts disconnected roots independently and joins shared ancestors without duplicate lanes. Graph lines use existing semantic colors. The list, parent links and native comparison selector support keyboard navigation; split/fullscreen behavior comes from the existing panel.

## Verification

Real repositories cover merges, refs and annotated tags, page stability/ref changes, unborn and detached worktrees, SHA-256 commits, root and alternate-parent diffs, scoped/deleted/literal paths, binary files, unreachable objects and disabled conversion helpers. API tests cover token/origin/session checks, malformed requests and selection races. Graph unit tests cover merges, shared parents, disconnected roots, octopus parents and pagination boundaries. Browser tests cover 320–1440px, both themes, keyboard navigation, loaded-page retention, parent selection, historical-content isolation, empty repositories, chat switching and stale-cursor recovery.

Official command contracts: [git-log](https://git-scm.com/docs/git-log), [git-for-each-ref](https://git-scm.com/docs/git-for-each-ref), [git-diff-tree](https://git-scm.com/docs/git-diff-tree), [git-rev-list](https://git-scm.com/docs/git-rev-list).
