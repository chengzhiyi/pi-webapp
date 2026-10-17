# Inline Git review verification

The normal sidebar keeps files above the diff; fullscreen places them beside it. The diff and file list have separate scroll regions, and the commit composer remains at the bottom. Selection uses both path and staged/working range, with a visible marker and pressed state. Worktree and historical file clicks retain their file lists and do not create another tab.

## Captures inspected

- [Normal sidebar](screenshots/inline-1440.png)
- [Wide pane](screenshots/inline-wide.png)
- [Tablet-width view](screenshots/inline-768.png)
- [Dark mobile view](screenshots/inline-390.png)
- [320 px view](screenshots/inline-320.png)
- [Historical file preview, desktop](screenshots/commit-preview-1440.png)
- [Historical file preview, mobile](screenshots/commit-preview-390.png)

The existing semantic colors, file icons, hairline borders and monospace diff styles are retained. A single compact preview header combines the path, selected range, counts and controls. Closing restores list space and keyboard focus. Selecting another file starts with an empty preview while its read is pending, preventing mismatched filename/content. Historical metadata remains scrollable in its list region.

## Checks

Type checks and production build passed. Unit/backend regression passed 248 tests. Full real-Chrome regression passed 63 tests, with one optional performance probe skipped. A final run of all 14 affected Git browser cases passed after stabilizing the preview close callback and reducing the short-window list minimum; this includes a 320 × 320 viewport assertion that the entire close control remains visible. Normal-height layouts keep the same 30% stacked list proportion.

Browser cases also cover staged/working distinction, rapid selection with delayed responses, in-place retry, stage/unstage/commit transitions, chat restoration, hidden polling, split/fullscreen, and keyboard Enter/Escape. Verification uses disposable repositories and never stages or commits the project's source changes.
