# Optional official Excalidraw plugin

Excalidraw is **not bundled or installed by default**. In **Plugins → Hosted plugins**, explicitly install and enable `@chengzhiyi/pi-excalidraw`. The offline official card contains metadata only; opening it does not contact npm or download editor code/fonts. Installation needs an available compatible official release. The verification artifact used on this branch is not evidence of npm publication.

The retired `PI_WEBAPP_HOSTED_EXCALIDRAW` flag is ignored, including `0`. Files, Terminal, Git and protocol-v1 plugins retain their existing lifecycle. An unsupported SDK fails explicitly rather than restoring builtin drawings or reloading sessions. This branch verifies SDK 1.3.0.

## Drawing workflow

- Ask the main conversation to draw. `excalidraw_read_me` describes compact inert elements; `excalidraw_create_view` creates a tool-result preview. New untouched revision-zero scenes initialize in the browser. Historical tool arguments are never treated as the latest scene.
- **Edit** opens the native editor, with hand editing, native undo/redo and native file/export menu. No extra model or drawing-service account is needed. PNG requires a browser.
- Native scenes are authoritative. Sync uses exact revisions; existing replacements/patches remain candidates for explicit acceptance/rejection. Hand edits invalidate stale acceptance rather than disappearing.
- The workbench entry also supports a blank canvas without a model. Browser backups are recovery data, not committed backend drafts.
- Workspace saves use relative `.excalidraw` paths, a loaded SHA-256, exclusive sibling locks and atomic commits. New paths are no-replace. External edits, symlinks, invalid paths, oversized files and stale generations fail closed. There is no force-overwrite button.
- Export source for portable independent backups. No remote sharing/upload action or cloud collaboration is introduced. Configured model calls are separate from local rendering.

The plugin owns `excalidraw_read_me`, `excalidraw_create_view`, `diagram_reference`, `diagram_create`, `diagram_read`, and `diagram_patch`. The host never registers a second builtin owner. It loads only verified package resources in isolated lifecycle realms under the existing strict CSP (no unsafe-eval or remote script/font sources).

## Existing drawings and browser backups

Stop all old bridge/writer processes before migration; binaries predating the cooperative marker cannot be fenced by it. The host's opaque compatibility reader verifies legacy envelope scope, identity, filenames and byte budgets under the original `scope.lock`. The plugin validates drawing data and imports by CAS once. IDs, scene geometry, revision, candidate (including stale candidates), focus, savedRevision, path and diskHash survive. The durable `hosted-migration.json` marker prevents a cooperative old writer returning. Original legacy bytes remain under `getAgentDir()/pi-web/diagrams/`; the new hosted store is separate. **No native user `.excalidraw` file is automatically rewritten or deleted.**

Historical `diagram:<id>` links resolve to the enabled hosted editor. Without it, old cards/links offer an honest install/enable recovery path, not a fabricated empty latest scene. A genuinely unavailable ID remains unavailable. Same-origin `pi-diagram:<session>:<id>` localStorage backups use their original keys: matching IDs offer explicit recovery; unavailable IDs retain recoverable source for explicit import into a new ID. Invalid backups are not applied. Changing browser origin/profile cannot magically recover another origin's storage; keep the old profile and export source before changing it.

Corruption, permission failures and lock contention are not missing-data signals. They preserve data and report errors. Never steal locks based on PID disappearance. Stop owners, back up storage, and inspect the specific journal/lock before deliberate recovery.

## Hotplug and limits

Install/enable/update/disable/uninstall retain the same SDK/TUI adapter and AgentSession: no page reload, `ctx.reload` or session reconstruction. Normal update waits for open editors; **Update and reopen now** explicitly warns that native undo history resets and requires every view to flush/acknowledge. Dirty/disconnected clients do not expire by TTL. Disable/uninstall drains frames and hides tools, retaining state, legacy sources and user files. Reinstall recovers committed data. See [bootstrap](hosted-production-bootstrap.md), [migration verification](hosted-excalidraw-migration.md), and [GC/recovery](hosted-plugin-gc.md).

Host-linked updater, crash recovery UX, complete multiwindow/browser/Electron/platform parity and reference-machine performance remain parent release gates. The original detailed browser matrix is retained as test provenance in the plugin repository, not claimed as rerun hosted acceptance.

## Reproduce

```sh
npm run check
npm run build
HOSTED_EXCALIDRAW_TGZ=/absolute/path/to/plugin.tgz npm test
HOSTED_EXCALIDRAW_TGZ=/absolute/path/to/plugin.tgz npx playwright test test/browser/hosted-production.spec.ts
```

The exact archive test validates import/save/restart/uninstall/reinstall with a real child worker. The full-host Chromium suite covers 1440px/390px install/edit/native undo/PNG/save/update/disable/uninstall/reinstall under production CSP with deterministic local registry/model fixtures, not real registry/provider acceptance. Font resources and notices belong exclusively to the separately installed plugin package; the host retains only metadata/icon/ID compatibility.
