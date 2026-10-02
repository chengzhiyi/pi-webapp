# Vendored DSH presentation sources

Source: DeepSeek Harness, https://github.com/deepseek-ai/deepseek-harness
Commit: 477b4f420553e8a52c2fbccc464d7561b239c443
Copyright (c) 2026 DeepSeek. MIT license: LICENSE.txt.

- `dockkit/`: `packages/client/ui-dockkit/src`. Original engine, gestures, tab strips, tab menus, floating windows and CSS. Only primitive imports and the type-only brand alias are adapted.
- `primitives/`: `packages/client/ui-primitives/src`. Original MarkdownText and its local dependency graph, tooltip, button and menu material. No Cordis or DSH server services are imported.
- `sidebar/SidebarRight.module.css`, `ExpandButton.module.css`, `locales.ts`: originals from `packages/client/ui-sidebar-right/src/client`.
- `sidebar/PanelChrome.tsx`: original glyphs/JSX extracted from `shell/SidebarRight.tsx`, with its injected service types replaced by props.
- `sidebar/labels.ts`: original projection with local type-only contracts.
- Theme CSS: original base/radius, focus, color, typography/elevation and Shiki sheets. `--dsh-content-font-size` aliases Pi's existing font preference.
- `shiki.css`: original `packages/client/ui-theme/src/styles/shiki.css`.

`../../PluginPanel.tsx` is the Pi-specific adapter. It keeps a docking controller per session, binds each tab to a plugin panel identity and localizes the original chrome. The generic start tab provides a Pi-local hint; DSH file/terminal/browser service implementations are not included. `../conversation/ConversationRoot.module.css` supplies aliases for the original DSH takeover width variables.

The full syntax highlighter adds lazy grammar chunks and KaTeX fonts. The bridge serves only the compiled asset inventory; no arbitrary filesystem paths are exposed. The plugin preview uses this original Markdown renderer; other chat messages keep their existing renderer.

CodeBlock uses DSH's original React token rendering arm for settled code too, to preserve syntax colors under Pi's strict CSP without permitting inline HTML styles.

KaTeX's generated style attributes are parsed as temporary data attributes, then assigned by the original React conversion, so even inert parsing respects that CSP. On narrow screens, exiting the automatic fullscreen preview returns to the conversation.

Host popovers reuse the same source revision: `primitives/MenuSurface.tsx` and its CSS are verbatim originals; `../chat/stat-dialog.module.css` is the original usage surface including backdrop filtering; `../conversation/MenuView.module.css` is the original command menu with only scrollbar variable names mapped to Pi. Pi command and model selectors render through `MenuSurface`, whose separate material layer preserves nested popup positioning. Sticky provider headers use DSH's menu group header fill token.

`composer/ComposerContentEditable.tsx` and `composer/claim-decor.ts` are verbatim originals from `packages/client/ui-conversation/src/client/input/editor`. `../conversation/PiComposerEditor.tsx` binds those originals to Pi's draft state with the same Lexical 0.49.0 plain text/history stack; it replaces the unstyled textarea. Input, ghost hint and placeholder CSS are copied from the original `skeleton/InputBar.module.css`. The command menu also retains original row markup (icon, localized label, alias, description, section title) from `ui-input-trigger/MenuView.tsx`; command routing and availability come from Pi's catalog and plugin declarations.
