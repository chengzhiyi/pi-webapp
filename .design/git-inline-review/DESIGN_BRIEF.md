# Inline Git file review

User direction: preview differences directly inside Git, retain the file list, avoid repeated new tabs, preserve the compact style and verify behavior.

Keep the existing toolbar, branch row, file statuses and bottom commit composer. Show no preview until a file is selected. Selecting it highlights exactly its path/range and opens a compact one-row diff header. Under 720 px of actual pane width, stack a bounded file list above the diff. At wider pane sizes, put the list beside the diff. Each region scrolls independently.

Use the same behavior for commit-detail file lists. Preserve shared binary/conflict/size states and refresh/retry behavior. On selection changes, clear obsolete patch data and cancel the old read. Staging transitions follow the same file; disappearing paths close the preview. Closing the preview restores the full list and keyboard focus.

Acceptance: no extra Dock tab for file clicks; file list remains visible; staged versus working content stays distinct; late reads never replace the current selection; writes and chat switches preserve coherent selection; no page overflow at 320, 390, 768 and 1440 px; actual pane width controls orientation, including fullscreen and split panes.
