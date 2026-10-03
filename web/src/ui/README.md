# UI modules

`web/src/ui/` contains pi-webapp's layout, conversation, sidebar, workspace, settings, attachment, trace, icon, and theme components. `web/src/PiApp.tsx`, `web/src/PiConversation.tsx`, and `web/src/PiWorkspaceBrowser.tsx` connect these components to Pi session data.

- `conversation/`: conversation container, composer, model selection, and attachments.
- `chat/`: messages, reasoning, tool calls, and usage.
- `trajectory/`: trace table, timeline, and toolbar.
- `workspace/` and `sidebar/`: workspaces, sessions, and navigation.
- `settings/`: appearance, resources, and models.
- `primitives/` and `theme/`: shared components, icons, and theme values.
- `shared/`: docking, Markdown rendering, composer editing, and supporting presentation components; source attribution and license are kept alongside the code.

The settings dialog and appearance selector follow the existing DSH component structure. The models page adapts DSH's connected-provider list, expandable model rows, and decimal K/M capacity inputs to Pi authentication and `models.json`. Pi's own model runtime supplies the catalog and saves built-in edits as `modelOverrides`.

Edit these source files directly, then run `npm run check`, `npm run test`, and `npm run build` from the project root.
