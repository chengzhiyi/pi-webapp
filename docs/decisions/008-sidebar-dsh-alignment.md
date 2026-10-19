# Sidebar visual alignment with DSH

## Reference

Use the local `deepseek-harness` source at revision `1600d8a1e1`, not an
independently invented sidebar treatment:

- `packages/client/ui-sidebar/src/client/SidebarRoot.module.css`
- `packages/client/ui-workspace/src/client/rows/Rows.tsx`
- `packages/client/ui-workspace/src/client/rows/Rows.module.css`
- `packages/client/ui-workspace/src/client/rows/WorkspaceBrowser.module.css`
- `packages/client/ui-theme/src/styles/base.css`
- `packages/client/ui-workspace/README.md`

This is visual/interaction alignment, not a claim that Pi implements all DSH
workspace features or its object/slot architecture.

## Decisions

- Use DSH semantic tokens, including `--dsw-radius-sm` (8px),
  `--dsw-radius-md` (12px), primary/tertiary labels, and neutral hover fill.
- Workspace headers are 34px; session cells are 32px, with 14px/20px titles,
  an empty or running 16px leading seat, and compact 10px/16px relative times.
  Full-width session cells share their header's edges. Do not add an indented
  card, blue selection rail, border, shadow, or blue workspace title.
- A folder identifies a workspace at rest; only its folder receives the active
  accent. Hover/focus swaps it to the expansion arrow and reveals trailing
  ellipsis/new-chat glyphs. The entire header shares the hover background.
- The ellipsis opens a shared-material menu. Only expose the supported
  remove-from-list action; do not invent Rename, Archive, Pin, or Delete APIs.
  The existing confirmation and non-deletion boundary stay intact.
- Idle sessions keep their status seat empty, as in DSH. Only actual running
  sessions show the loader; accessible status descriptions remain available.
  Pi does not currently expose DSH's unread-completion or interaction states.
- Header controls use the shared 8px/12px corner scale, not circular buttons.
  Keep the 56px rail, shell rhythm, search transitions, and bottom settings seat.
- The monochrome Pi logo inherits text ink so it stays legible in both themes.

## Local adaptations retained

Native buttons and disclosure/list semantics preserve keyboard access rather
than copying DSH's tree roles without its navigation implementation. Focused
rows reveal actions; coarse-pointer devices use the same glyphs with 40x44px
hit targets and 44px rows. The mobile overlay, draft/attachment preservation,
async navigation lock, error/empty states, and destructive-action confirmation
remain independent of this visual alignment.

## Verification

`test/browser/sidebar-management.spec.ts` checks light/dark geometry, neutral
selection, folder/arrow/action swaps, idle/running seats, compact times, menu
keyboard behavior, safe removal, and the existing responsive/draft flows.
`test/session-time.test.ts` checks time units, localization and invalid dates.
