# Compact Git diff navigation

Keep code edits prominent inside the existing Git review panel. Retain the file list, independent scrolling, current Dock behavior, semantic colors and compact controls.

- Hide structural Git headers after parsing. Source lines resembling those headers must remain visible.
- Replace raw hunk syntax with muted line-location separators. Preserve readable file-mode and rename/copy notices, and indicate missing final newlines inline.
- Group contiguous additions/deletions as one change. Context or hunk boundaries separate changes.
- Keep previous/next, position count, refresh and close in a 38 px toolbar. Place the filename above scope/counts inside its flexible identity area.
- Start at 0/N. Next selects the first change. Disable at either boundary without wrapping, and while loading or failed. Metadata-only and non-text previews have no navigation targets.
- Mark the selected block; scroll only the diff viewport while retaining horizontal offset and keyboard focus. Changed patches and file switches reset selection/scrolling; unchanged refreshes preserve position.
- Use the same renderer for workspace and committed-file previews. Verify widths 1440, 768, 390 and 320 px, fullscreen and a 320 × 320 short window, including light/dark themes.
