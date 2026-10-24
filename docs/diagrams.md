# Local Excalidraw diagrams

## Use

Rebuild and restart pi-webapp (`npm run build`, then restart the launcher). With `pi -e .`, rebuild, wait for all chats to be idle, then `/reload` and `/web`. A browser refresh alone does not register backend tools.

1. **Describe the drawing in the main chat**, e.g. “画一张分层架构图，区分入口、核心、运行库和外部服务”. No diagram home page, extra form, tool names or IDs are required.
2. The agent reads `excalidraw_read_me` and calls `excalidraw_create_view`. The drawing appears in that tool's result, **before the final answer**, not as a separate application appended to the answer. A new diagram is automatically materialized when its preview becomes visible; there is no initial acceptance step. The backend still truthfully reports `pending_canvas` until a browser has materialized it.
3. Click **Edit**. The right panel contains **the native Excalidraw editor**, without an outer save toolbar, second prompt field, suggestions or diagram list. Drag, edit text, zoom and use native undo/redo. The optional workbench **Excalidraw** entry opens a blank native canvas directly, including without a model.
4. Continue asking for changes **in the main chat**. All loaded diagram models in this session flush pending manual changes before the prompt is sent. `diagram_read({})` reads the active drawing and latest revision; selecting an editor focuses it. `diagram_patch` proposes local changes. Existing-diagram modifications have **Apply edits / Keep original in chat**, never a review form in the panel. An outdated candidate cannot overwrite newer manual edits. When multiple drawings could be intended, clarify which one; active means the latest created or explicitly focused drawing, not semantic intent inference.
5. Use Excalidraw's hamburger menu for **Save / Save as to workspace**, **Open workspace diagram**, **Import source**, **Download source**, **Export PNG**, **Export transparent PNG** and **Recover local backup**. Save/Open ask for a workspace-relative path only when invoked. Ctrl/Cmd+S opens Save. The menu shows workspace-save status; normal editing does not display revision/path controls outside the canvas.
6. Save defaults to `diagrams/<id>.excalidraw`. A new path must not exist. An existing file can only be updated from its loaded hash. Conflicts preserve the current draft; use a new path or explicitly reload. There is no force-overwrite button. Source download remains available even if synchronization fails. PNG exports the current confirmed scene, not an unaccepted modification.
7. Recovery lists only this session's browser backups and imports a selected backup as a **new** drawing. Browser backups are best-effort, not durable workspace files.

Ordinary chat's Pause/Stop controls manage generation. The plugin makes no independent model calls; normal provider billing/data policies apply. Deterministic test fixtures do not guarantee a real model's semantic accuracy or aesthetic quality.

## Agent drawing format

Preferred tools (also registered in retained SDK sessions):

- `excalidraw_read_me`: local format, safe palettes, examples, layout guidance and follow-up workflow.
- `excalidraw_create_view({title?, elements, id?, baseRevision?})`: `elements` is a JSON array string of **1–150 compact inert Excalidraw skeletons**, with explicit positions and geometry. Types: rectangle, ellipse, diamond, text, line, arrow. Shape labels use `label:{text,fontSize}`; arrows use relative `points` and `start:{id}` / `end:{id}`. Styles include safe colors, fills, strokes, roughness, opacity, font size and groups. New drawings initialize automatically. Supplying an existing `id` and exact `baseRevision` proposes a full replacement requiring chat review.
- `diagram_read({id?, elementIds?})`: latest synchronized native elements/revision; omit ID for the active drawing. Reads default to 100 elements and report truncation.
- `diagram_patch`: add/remove nodes and edges; update labels, geometry and styles without rebuilding untouched elements. Explicitly moving/resizing a shape reroutes incident arrows, so those manually routed paths can change. Unrelated native paths remain intact.

`diagram_reference` and `diagram_create` remain compatible graph shortcuts (30 nodes / 60 edges); their initial results now also initialize automatically. Their historical wire status `pending_canvas_acceptance` is retained for compatibility, but is **not** an instruction to make users accept first creation. Graph grouping is one level and assists selection, not nested layout. Nodes added without coordinates use the conservative append-to-right layout.

The compact drawing format is allowlisted; it is not arbitrary native JSON. URLs, images, embeddings, scripts and reference-app pseudo-elements (`cameraUpdate`, `restoreCheckpoint`, `delete`) are not accepted. Use versioned local reads/patches instead. Native import supports basic shapes, text, lines, arrows and free drawing; unsupported embedded resources are rejected rather than stripped. Final scenes are bounded to 400 elements / 512 KiB.

## Progressive display and host integration

The implementation follows the public [excalidraw/excalidraw-mcp](https://github.com/excalidraw/excalidraw-mcp/tree/157aa23ceb1976008aadc89eb05e3444060f09d6) reference's **agent tools → tool-result drawing → native editor → manual-state return** interaction model. It uses the existing official Excalidraw 0.18.1 component and local plugin lifecycle. It does **not** install that MCP server or claim to reproduce Doubao's private implementation.

The additive native `workbench.toolViews` contribution receives a tool call's partial arguments and eventual result. The host keeps these views attached to the tool call, outside collapsed execution details and above the final answer. `workbench.beforeSend` lets enabled plugins finish manual-state synchronization before the next main-chat prompt. A failed hook restores the prompt, shows an error and does not send stale state to the agent; switching sessions during the hook cancels that send. External protocol-v1 slots continue working unchanged.

During argument streaming, the view extracts only complete top-level JSON objects from `elements`, validates them, converts them through the official Excalidraw helper, and refreshes an SVG preview. Preview-only dangling bindings are omitted until their targets arrive. Final server validation remains authoritative. This is **actual incremental element display when the provider emits tool-argument updates**, not simulated progress. It is not per-stroke drawing animation, smooth camera choreography, or a promise that every model/provider streams parseable arguments. Without deltas, the full result appears on completion. A stopped/failed partial preview is not a committed diagram or file.

This native contribution is **not a general MCP Apps/AppBridge host**: no `ui://` resource fetching, arbitrary remote HTML, sandboxed third-party App transport or universal MCP connector is added. Reusing the upstream App unchanged would require that separate host lifecycle/security bridge and its React 19/SDK build, rather than merely adding an MCP URL. Here the existing local revision/file protections are retained rather than replaced with the reference's checkpoint storage. No remote drawing service or Excalidraw account is needed. The reference's “Open in Excalidraw” action uploads a diagram; that action is intentionally not added.

## Ownership, persistence and security

- Bundled plugin: `src/plugins/builtin/diagrams/{contract,server,client}`, not an independently published plugin package. Tools share `ServerPluginRegistry.runAgentAction` enablement gates. Disabling the plugin closes its panels and rejects backend tool/actions, even if schemas remain visible in an existing runtime.
- Native scenes are authoritative after hand edits. Browser sync is serialized with compare-and-swap revisions. Only untouched revision-zero creations may use automatic initialization. Existing replacements and patches retain explicit chat review and stale-base checks. Main-chat pre-send synchronization includes text changes, not just position summaries.
- Disk saving checks the loaded SHA-256, takes an exclusive sibling lock, fsyncs a temporary file and commits atomically. New-file creation is no-replace. Paths stay in the current workspace; absolute paths, symlinks, non-regular files and other extensions are rejected. Only the conventional `diagrams/` parent is created automatically. Never steal a live writer's lock.
- Cooperative locks cannot prevent every race by an uncooperative same-user external editor. Plugins are trusted host code, not a filesystem sandbox.
- Runtime drafts and candidates belong to a session in the running bridge. Browser backups remain on the same origin and session; storage failures are reported. Save files for recovery across server restarts, changed ports or cleared browser storage. Unmaterialized structures and every keystroke before a crash are not promised durable.
- No cloud collaboration, uploads, remote libraries, independent model/telemetry service or headless browser is added. PNG requires a browser. Model inputs follow the existing configured provider; local rendering does not imply offline model inference.

## Resources and maintenance

The plugin entry remains thin. `Canvas.tsx`, its editor CSS and the official component load on demand for visible previews/editors or an active streamed drawing. Offscreen finalized previews defer loading/refresh. Inline SVG blob images never mount editable canvases. Hidden tabs unmount native editors while retaining small models; JavaScript remains cached.

`scripts/excalidraw-assets.mjs` copies unmodified WOFF2 fonts, including CJK subsets, into an explicit same-origin asset inventory. `canvas-env.ts` configures local fonts. The checked build transform removes the pinned package's CDN fallback without relaxing CSP. Upgrades require reviewing that transform, font licenses, notices and scene/export regressions. Bundled notices are in `assets/diagrams-NOTICES.txt`.

## Checks

```sh
npm run check
npm run build
npm test
npx playwright test test/browser/diagrams.spec.ts test/browser/diagrams-samples.spec.ts test/browser/diagrams-experience.spec.ts test/browser/diagrams-agent.spec.ts
git diff --check
```

Coverage includes the actual SDK tool loop driven from the main browser composer with a deterministic model fixture; waiting for manual sync before sending the next prompt; incremental argument previews before a tool result exists; direct initialization; native editing/undo/redo; chat-only review and stale-candidate protection; white/transparent PNG, source, import/open/save/recovery; plugin disablement; ten Chinese graph fixtures and a 30-node timing measurement; 1440/390 px views and no third-party requests. Chromium viewport checks are not packaged Electron, cross-browser, or real-model generation certification.
