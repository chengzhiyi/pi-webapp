# ADR-006: Inline Git file review

Status: Accepted

Date: 2026-10-17

## Decision

Selecting a working-tree file previews its diff inside the current Git tab. Selecting a committed file previews its historical diff inside its existing commit-detail tab. Neither file action calls the Dock tab-opening API. History commit/parent navigation keeps its existing behavior.

`GitFileReview` keeps the file-list DOM stable and gives list and diff independent scrolling. Preview is opt-in; closing it restores the full list. Container queries use the actual Dock pane width: under 720 px the list occupies roughly 30% of review height above the diff; wider panes use a 28% file column and a remaining diff column. The fixed commit composer and repository controls retain the compact layout.

`GitDiffView` continues to share patch rendering, binary/conflict/size notices, refresh and retry behavior. Inline mode combines path, scope, counts, refresh and close in one compact row. The diff viewport owns both scroll axes, keeping horizontal scroll available without scrolling to the end of a long patch.

### Code-focused preview and navigation

The preview removes transport headers (`diff --git`, `index`, file prefixes) after parsing, never by filtering raw strings that might be actual source. Hunk syntax becomes a muted line-location separator. File-mode changes and rename/copy-only patches retain readable notices; missing final newlines use a small annotated marker beside the affected line.

Previous/next controls navigate contiguous addition/deletion blocks. A replacement is one block; intervening context and hunk boundaries start another. Before navigation the counter is `0/N`; the first Next selects the first block, and boundaries disable without wrapping. Navigation marks the entire current block, scrolls only the diff viewport, retains horizontal offset and does not move keyboard focus. Loading, failed, binary and metadata-only previews disable navigation. A different file or changed patch resets selection and scrolling; an identical refresh retains the current position.

Path and scope/counts share a two-line identity area within the 38 px toolbar, leaving space for navigation, refresh and close even in a 320 px pane. This rendering is shared by working and historical comparisons.

## Selection and consistency

The chat-owned Git model stores `{path, area}` separately from history's selected commit. A pure reconciliation helper preserves the chosen side when it still exists, follows the same file into its remaining staged/working/untracked range, and clears selection when the path disappears. It never silently selects a different file. Successful status reads reconcile selection; failed, hidden or pending reads do not discard it.

Each preview's component key includes the selected file/range (and commit/parent for historical diffs). Switching files unmounts the previous read, aborts its controller and starts with empty preview data. A late response cannot render under another file's heading. Hidden previews stop polling. The existing changed-event refreshes visible status, controls and diffs after writes; the Git refresh button also refreshes the embedded preview.

Selected file buttons expose pressed state and a visible selection marker. Closing from the toolbar or Escape within the preview returns focus to the file button without changing its scroll position. Selecting a different parent clears a historical file preview before loading that comparison. Existing Git authentication, scope and write policies are unchanged.

## Verification

Unit tests cover preserving both sides of a partially staged file, staging/unstaging transitions, conflicts and removal. Real Chrome tests cover no tab growth, retained file lists, independent scroll, pane-width layout changes, keyboard close/focus restoration, stale response cancellation, in-place retry, selection after stage/unstage/commit, chat restoration and hidden polling. Existing history tests now assert that opening a file diff retains the commit file list and does not add a tab. Tests use disposable repositories only.
