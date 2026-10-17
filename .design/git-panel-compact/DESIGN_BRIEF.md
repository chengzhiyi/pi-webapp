# Compact Git panel

Date: 2026-10-17

## User direction

The user rejected the previous layout because it contained too many forms, consumed too much space and lacked the compact feel of a Git tool. Retain the current application's design language and existing Git capabilities.

## Layout and interaction

- Keep Changes / History navigation in its existing toolbar.
- Use one compact repository row: branch picker, short repository name, optional upstream counts and changed-file count. Full root/HEAD/upstream information is available through its tooltip.
- Give changed files the main scrollable region. Keep per-file stage/unstage buttons visible and accessible.
- Place a compact staged-only commit composer at the bottom, independent of file scrolling. Expand the message area while editing. Support Ctrl/Cmd+Enter without triggering submission during IME composition.
- A subdirectory workspace displays a concise root-workspace explanation instead of a disabled commit form.
- Branch management opens from the branch name as a transient surface using existing menu material and modal keyboard/focus behavior. Initially show a search field and branch list. Only an explicit New branch action reveals the creation form.
- Close the branch surface on Escape, outside pointer interaction, success or leaving the Git view. Preserve branch drafts in the existing chat-owned model.
- Keep existing snapshot, running-chat, dirty-tree and write-error policies.

## Visual direction

Dense developer-tool hierarchy with existing semantic tokens, hairline borders, small radii and restrained emphasis. Avoid persistent stacks of form labels, repository paths and explanatory paragraphs above the files. Reuse shared menu surface and focus ownership rather than introduce a new overlay system.

## Acceptance

- At normal desktop/tablet/mobile heights, the first file appears within 150 px of the Git pane top.
- The unfocused commit form stays below 115 px; scrolling a long file list does not move it.
- Default view has no branch creation/switch forms.
- Search, Escape, outside dismissal, focus restoration, shortcut submission and draft preservation work.
- Verify 1280, 768 and 375 px in both light and dark themes, plus existing write, history, diff and split-pane behavior.
