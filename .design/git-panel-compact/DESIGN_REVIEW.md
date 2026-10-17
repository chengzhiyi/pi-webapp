# Design Review: Compact Git panel

Reviewed against: [DESIGN_BRIEF.md](DESIGN_BRIEF.md)

Direction: compact developer tool using the existing application design system.

Date: 2026-10-17

## Result

The persistent form stack is removed. A single repository row leads directly into the changed-file list, while a short composer stays at the bottom. Branch search and creation share an on-demand surface instead of taking vertical space from the list. Repository subdirectories show a concise explanation in place of an unusable commit form.

## Screenshots captured

Each viewport/theme includes the default long-file-list view, the branch search surface and the branch creation state. Screenshots come from real Chrome running the built application against disposable Git repositories.

| Screenshot | Viewport |
| --- | --- |
| [compact-1280-light.png](screenshots/compact-1280-light.png) | 1280 × 800 |
| [branch-list-1280-light.png](screenshots/branch-list-1280-light.png) | 1280 × 800 |
| [branch-picker-1280-light.png](screenshots/branch-picker-1280-light.png) | 1280 × 800 |
| [compact-1280-dark.png](screenshots/compact-1280-dark.png) | 1280 × 800 |
| [branch-list-1280-dark.png](screenshots/branch-list-1280-dark.png) | 1280 × 800 |
| [branch-picker-1280-dark.png](screenshots/branch-picker-1280-dark.png) | 1280 × 800 |
| [compact-768-light.png](screenshots/compact-768-light.png) | 768 × 1024 |
| [branch-list-768-light.png](screenshots/branch-list-768-light.png) | 768 × 1024 |
| [branch-picker-768-light.png](screenshots/branch-picker-768-light.png) | 768 × 1024 |
| [compact-768-dark.png](screenshots/compact-768-dark.png) | 768 × 1024 |
| [branch-list-768-dark.png](screenshots/branch-list-768-dark.png) | 768 × 1024 |
| [branch-picker-768-dark.png](screenshots/branch-picker-768-dark.png) | 768 × 1024 |
| [compact-375-light.png](screenshots/compact-375-light.png) | 375 × 812 |
| [branch-list-375-light.png](screenshots/branch-list-375-light.png) | 375 × 812 |
| [branch-picker-375-light.png](screenshots/branch-picker-375-light.png) | 375 × 812 |
| [compact-375-dark.png](screenshots/compact-375-dark.png) | 375 × 812 |
| [branch-list-375-dark.png](screenshots/branch-list-375-dark.png) | 375 × 812 |
| [branch-picker-375-dark.png](screenshots/branch-picker-375-dark.png) | 375 × 812 |

A [desktop panel capture](screenshots/panel-desktop-light.png) is also provided for inspecting the right tool pane without unrelated chat content.

## Findings resolved

- **Hierarchy:** files now appear directly below the compact repository row. Browser assertions keep the first file within 150 px of the pane top, including its Dock tab strip. Full root paths, HEAD and upstream details moved to the short repository name's tooltip.
- **Density:** the unfocused commit form stays below 115 px. Its message field expands on focus, without an intermediate resize animation that could clip freshly filled multiline text in captures.
- **Scrolling:** a 71-file fixture proves that scrolling to the final file leaves the commit form at the same vertical position.
- **Branch UI:** search/list is the initial state; only New branch reveals name and checkout controls. The surface stays within the pane, uses the shared menu material and shows dirty-worktree reasons in context.
- **Keyboard:** initial search focus, creation-field focus, Tab wrapping, Escape, outside dismissal and return focus are verified. Successful branch writes close the surface; failed writes preserve draft fields. Ctrl/Cmd+Enter uses the existing composition lifetime guard, including a closing keydown after compositionend.
- **Theme and responsiveness:** all default/list/create screenshots were inspected at the three breakpoints in light and dark themes. Hairline borders, small radii, typography and semantic colors follow the existing UI. Narrow-screen primary branch/file actions retain larger touch targets; group-title spacing compensates without pushing files down.
- **Feedback:** operation results appear in the footer with a dismiss action; branch failures appear in the branch surface. Pending, blocked and failed reads retain localized feedback. Existing write snapshot and background-chat protections remain in place.

## Outstanding issues in the requested scope

None found in the captured states. Existing history and diff navigation remain part of the regression suite; this refinement changes the layout and branch presentation, not their information architecture.

## Validation

Type checks and production build passed. The unit/backend suite passed 246 tests. The full browser suite passed 59 tests with one optional performance probe skipped; the final design-capture run additionally passed all six exact viewport/theme cases.
