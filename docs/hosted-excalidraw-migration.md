# ORI-31: optional-default Excalidraw extraction

## Delivered scope

Hosted drawing ownership is the production default; the official package is **absent until explicitly installed**. The old opt-in flag is ignored, including `0`. Root `@excalidraw/excalidraw`, exclusive overrides/transitive packages, builtin domain/client/server/tool/API registrations, dedicated fonts/notices and Vite font/CDN transform are removed. Files/Terminal/Git and protocol-v1 remain. The same long-lived SDK/TUI adapter performs changes without page reload, `ctx.reload` or AgentSession replacement. An incompatible SDK/foreign tool owner fails explicitly, never restores builtin/reload fallback.

The existing `legacy-checkpoints.ts` at assignment base already had no builtin persistence import. It is retained as a minimal opaque, bounded, exact workspace/session-envelope reader with the original cooperative lock and migration marker. Drawing validation remains in the external plugin. The import CAS occurs once. Original legacy bytes, IDs, geometry, stale candidates, revision, focus, savedRevision/path/diskHash and user-owned native files are preserved. Stop old uncooperative/pre-marker writers first. Locks are never auto-stolen.

The host retains only a tiny icon/metadata/history-recovery contribution. Historical `diagram:<id>` aliases select the enabled hosted editor; absent/disabled UI explains install/enable recovery and does not reconstruct scenes from tool arguments. Plugin model tests cover the unchanged same-origin localStorage keys for matching IDs (explicit recovery) and unavailable IDs (recoverable backup, no fake scene/write). The runtime/editor/font implementation itself is unchanged from plugin `c54e0b6`.

## Evidence and regression provenance

Migration was verified **before removal**: 23/23 host drawing+installation+exact-tgz tests. After removal, executed plugin tests retain all 8 original plugin-domain/model cases (3 drawing, 3 validators, 1 store and 1 recovery); the other 5 original host boundary tests have hosted/broker/default-absence replacements, not a retained production drawing domain. New file-broker parity tests preserve native file path/hash/no-replace/size/link/lock/race boundaries. New opaque-loader tests preserve corrupt and scope-mismatched bytes, refuse live locks and linked scopes, and fence the test-only old cooperative writer.

Exact archive testing installs 426 real resources, launches the actual child backend, imports old and rich saved/stale-candidate checkpoints, preserves focus/metadata, syncs/saves, restarts and uninstalls/reinstalls without losing the original native file. Full-host Chromium at 1440px/390px exercises actual authenticated HTTP, actual worker/tgz, retained SDK session, native edit/undo/redo/PNG/save, pending update, explicit warned reopen, disable/uninstall/reinstall and identity retention under strict production CSP. Registry/model transports are deterministic fixtures, not published releases or external provider acceptance.

The detailed provenance and original seven builtin-browser suites are retained in the plugin's `test/MIGRATION-PROVENANCE.md` and `test/legacy-{source,browser}/`. Archived suites are **not counted as passing hosted tests**. The wider menu/theme/Mermaid/import/export/IME/multiwindow matrix remains a parent acceptance gate.

## Clean published-shaped offline consumer

Build the host, pack without lifecycle scripts, then install into a clean isolated directory:

```sh
npm run check
npm run build
HOSTED_EXCALIDRAW_TGZ=/absolute/path/plugin.tgz npm test
PI_WEBAPP_HOSTED_EXCALIDRAW=0 node --import ./test/setup-env.mjs --experimental-strip-types --test test/hosted-bootstrap.test.ts
HOSTED_EXCALIDRAW_TGZ=/absolute/path/plugin.tgz npx playwright test test/browser/hosted-production.spec.ts
npm pack --ignore-scripts --pack-destination /absolute/path/artifacts
# In a fresh temp directory, package.json contains the local host tgz plus exact
# @earendil-works/pi-coding-agent and pi-ai 1.3.0 consumer peers:
npm install --offline --ignore-scripts --no-audit --no-fund
# Back in this checkout:
node scripts/verify-no-builtin-drawings.mjs /absolute/path/consumer
node scripts/verify-offline-hosted-consumer.mjs /absolute/path/consumer
```

No dependency symlink is mutated. No install lifecycle scripts, registry requests, credentials, publication, push or release merge are needed. Dependency/artifact inspection rejects editor/converter/roughjs dependencies and editor/font signatures in **both packed browser and Node output**. KaTeX math fonts and the SDK's independent `grok-mermaid` dependency are intentionally not mislabelled as Excalidraw code. Source metadata/icon/old-ID mentions are allowed; the word Excalidraw is not banned.

The installed-consumer startup check uses the **actual installed extension**, SDK/TUI `/web` command, authenticated HTTP, and Chromium with a clean provider-free profile and retired flag `0`. It verifies absent official card, no builtin drawing tools/API, zero plugin code/font fetch, zero external fetch and zero page errors. It does not claim a packaged Electron launch.

Exact final counts, commit IDs, artifact hashes and install logs are delivered on ORI-31, outside this packaged document to avoid an artifact hashing itself. Development protocol release protection is unchanged: the locked `0.2.0-dev.1` snapshot is verification-only and publication remains blocked.

## Not claimed

No blanket A01–A25 pass. Packaged Electron/macOS/Windows/Linux, other browsers, full legacy browser-matrix conversion, distributed/multiwindow crash recovery, paired application updater, registry publisher provenance and reference-machine performance remain parent gates. State/code GC and postcommit recovery semantics are not modified here. Build's existing large-chunk/use-client and worker debug-proxy missing-default warnings remain; do not relax CSP or resource budgets to hide them.
