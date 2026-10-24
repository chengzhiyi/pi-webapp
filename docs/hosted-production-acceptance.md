# Hosted Excalidraw: current implementation acceptance

Engineering checkpoint, **not A01–A25 release approval**. Authorization covers implementation, not npm publication, push or release-branch merge. Shared alpha was not edited. Historical results below are not represented as reruns of the latest source.

## Integrated implementation

- Optional-default extraction remains: no builtin drawing implementation/API/tools, root Excalidraw dependencies, drawing fonts or drawing-specific host build. Offline official catalog and explicit historical-data recovery remain.
- Host integrates ORI-34 focused tests, ORI-35 aggregate multiview transport and ORI-36 host-linked updates (`4c0ebbd`), plus synchronization/hash test corrections (`aef2c31`). Plugin source **`6108c6b`** integrates bounded viewport persistence/restoration and safe absent/empty/deleted labels. Groups and arrow bindings remain covered.
- Independently rebuilt exact development archive: SHA-256 **`9a9b92631e5a534c1fda83e7bbeb5743d1de20be91bda39f6984a01bb1e71a68`**, **15,665,065 bytes**, 426 declared resources. Guard validates archive paths, every resource hash/size, entrypoints, licenses and no workspace/file/link dependency leakage. This is a local development artifact, not a published npm release.
- Same-profile starvation was demonstrated by ORI-35 using 44 Chromium max-sockets-per-group stalls and a controlled connection-release intervention. Browser views now use bounded authenticated aggregate reads, not per-frame held HTTP/1.1 polls. Per-view scope/generation/capability and real flush/ack remain enforced.
- Host startup synchronizes already-installed compatible official plugins even with independent `notify`, preserving absent/disabled/pin/no-downgrade intent. Open-editor pending is not marked complete; failures preserve compatible runtime and retry next startup. Offline incompatible runtime cannot publish tools/assets. Business-package updater's local-pair preflight remains conservative, **not a staged atomic paired update**.
- Production uses `hosted_plugins_changed`, not v1's page-reloading event. Desktop download permission remains limited to trusted same-origin blob PNG/SVG/JSON/Excalidraw exports; remote/foreign/executable downloads are denied. CSP unchanged.

## Latest executed verification

- Host check/build PASS. Full Node **391 pass / 1 Windows-only skip** plus desktop **92 pass**: **483 pass / 1 skip**. New acceptance-reporter tests are included. Plugin check/build and **17/17** tests PASS. Exact archive integration/actual-bootstrap event tests ran, not skipped.
- Complete-App Chromium suite against the independently built archive: **15 passed bodies / 0 failed bodies / 1 skipped legacy-only diagnostic**. The original 1440/390 production lifecycle files are unchanged and pass cleanly. Same-profile second window, repeated SDK cards, native exports/theme, composition/drag safe point, labeled candidate reject/apply/stale protection, bare-shape candidate apply and native viewport restoration all reach their assertions.
- **Three of those 15 green bodies still have shutdown-failed-closed annotations. Only 12 are clean body + teardown passes.** A09 bare review, streaming subtree removal and dirty losing-window reload leave old uncertain registrations. This is an unresolved product lifecycle gate, not harmless logging. `scripts/verify-hosted-browser-results.mjs` explicitly exits **1** on this final JSON report. It also rejects missing production sizes, skipped product tests, retries, global errors and incomplete results; only the named obsolete transport diagnostic may skip.
- Initial integrated A06/A09 failures were read-before-sync races introduced by now-persisted native viewport. Test synchronization now waits for actual initial native fit/zoom/pan persistence and a new-generation editor, without weakening full-scene/revision/CAS assertions. Focused A06 additionally proves **byte-identical native canvas PNGs** before/after the real generation switch, unchanged scene/revision, retained SDK/parent boot and stale-generation 409. No backend echo is substituted for rendered pixels.
- New reference run: M1 Pro/16 GiB/macOS arm64, Node 24.21.0, Chromium 153.0.8010.12. **20 warmups + 50 measured** staged same-version controller/worker replacements; 100 elements/groups/Chinese plus explicit imported viewport fidelity and full checkpoint hash verified. P50 **1,067ms**, P95 **1,241ms**, max **1,366ms** (target P95 <=2s); 70 old worker PIDs confirmed exited, six unique tools, one controller frame, two state snapshots. Local archive integrity/extraction ~1,833ms under concurrent local test load, **not network installation time**. Post-GC browser median growth ~1,033,280 bytes meets the bounded smoke budget, **not proof of no continuous heap growth**. No active editor, direct port/timer/listener census or child CPU/RSS certification.
- Earlier source's actual macOS arm64 packaged app-directory smoke passed native drawing/undo-redo/Chinese save/PNG/generation reopen/disable-reenable with host PID and parent boot retained. This latest wave did **not** rebuild/rerun that packaged application. Earlier cached runtime reuse, ad-hoc signature checks and fixture-selected download destination do not certify a DMG install, notarization, native dialogs or OS IME.

## Unresolved implementation gates and real continuation

**ORI-37** owns normal removed-view flush-before-destruction and dirty-reload reconciliation. A newer server CAS revision, a replacement clean frame, localStorage, elapsed time or lost socket is not proof that an old realm had no newer draft. No TTL/registry clearing/fabricated ack or automatic Restore was added. Preserve losing geometry rescue/download and explicit Restore. Lost/unconfirmed views must continue to fail closed until a real identity-bound safe handoff or explicit audited reconciliation exists.

**ORI-38** owns staged controlled host/plugin combination updates and the preflight→selection→restart consistency gap. ORI-36's worker-exists/local-compatibility callback does not attest a future host protocol implementation or stage a necessary new plugin release. Manual native-shell replacement is not inherently transactional; startup compatibility validation must retain data and visibly refuse an incompatible runtime. Native installer atomicity, publisher provenance and full OS updates are not claimed.

Both are actual assigned child tasks; parent integrates and verifies their commits. Existing implementation authorization remains sufficient. No repeated implementation approval is requested.

## A01–A25 matrix — scope not silently reduced

| Item | Current evidence / remaining gate |
| --- | --- |
| A01 | Prior clean tgz/offline installed closure and actual installed `/web` startup pass; no editor/font in host. All-target release artifacts not certified. |
| A02 | Current Chromium same-object SDK/boot install/edit/update/disable/uninstall lifecycle passes. Prior packaged macOS PID/boot check only. |
| A03 | SDK/TUI direct/nested/codemode/tombstone negatives pass. |
| A04 | Plan/allowlist tests pass; actual v1 plan-mode package UI interaction remains. |
| A05 | Retained/background batch drain pass; real long-provider-stream/multiwindow combinations remain. |
| A06 | Native synchronized zoom/pan and byte-identical rendered pixels now pass; 100 grouped shapes and imported Chinese checkpoint preserved. Broader native freehand/arrow/text matrix remains. |
| A07 | Real held drag + synthetic composition retains prompt and blocks send until safe. OS-native IME not run. |
| A08 | Pending default, explicit undo-reset warning and same-generation native undo/redo pass. |
| A09 | Labeled/bare candidates, apply/reject/stale protection and progressive preview bodies pass; bare-review/removed-stream teardown remains RED (ORI-37). |
| A10 | Native source/Open/SVG/transparent PNG/backups/themes pass at English-light1440 and Chinese-dark390. Prior packaged macOS save/PNG only; OS dialogs not certified. |
| A11 | Same-profile windows/repeated cards now pass; actual CAS loser/download/reload/explicit Restore body passes, old unknown-view reconciliation remains RED (ORI-37). |
| A12 | Installer/manager interruption/integrity/failure negatives pass; comprehensive disk-full/cancellation product matrix incomplete. |
| A13 | Archive/resource negatives and strict CSP pass; desktop trust-bound download allow/deny tests pass. |
| A14 | Broker/runtime fence real state/file writes; current native switch rejects stale generation. Wider stale callback matrix remains. |
| A15 | Precommit failure preserves old data; unsupported cross-schema migration refuses. Generalized reverse migration/rollback not certified. |
| A16 | Prior real health/fork/prepare/commit/cleanup SIGKILL and fingerprint-bound offline recovery tests pass bounded scope. External isolation/power loss/OS uncertain-save gates remain. |
| A17 | Stable compatibility/no-downgrade/pin/retry/persisted diagnostic tests and real policy UI interactions pass. No periodic independent scheduler claimed. |
| A18 | Default host-linked installed-plugin synchronization now passes (including disabled/pin/absent/offline retry). Full controlled paired selection/restart remains ORI-38. |
| A19 | Current browser uninstall/reinstall retains files/drafts; prior packaged disable-reenable retains bytes. |
| A20 | 50 different-version backend GC + 70 current controller/worker cycles pass bounded checks. Direct port/timer census and long-term heap proof remain. |
| A21 | Real SDK/TUI factories/retained sessions and prior installed `/web` exercised; wider terminal interactions remain. |
| A22 | Prior packaged macOS arm64 bounded drawing only. Latest packaged wave, Windows/Linux/macOS x64, OS IME/native dialogs NOT RUN. |
| A23 | Current Chromium complete-App suite has three unresolved lifecycle failures; Electron prior bounded test only. Firefox/WebKit not installed/run. |
| A24 | Opaque checkpoint/ID/focus/history/localStorage migration regressions and no dual builtin registration pass bounded tests; comprehensive old-history browser recovery remains. |
| A25 | Current specified staged-switch reference meets P95 target; network install/child CPU/RSS/active-editor/all-platform performance NOT RUN. |

## Reproduction

```sh
npm run check
npm run build
HOSTED_EXCALIDRAW_TGZ=/absolute/plugin.tgz \
HOSTED_EXCALIDRAW_SHA256=<recorded-exact-sha256> npm test
HOSTED_EXCALIDRAW_TGZ=/absolute/plugin.tgz \
PLAYWRIGHT_JSON_OUTPUT_FILE=/absolute/playwright.json \
  npx playwright test test/browser/hosted-parity.spec.ts \
  test/browser/hosted-production.spec.ts test/browser/hosted-transport.spec.ts \
  test/browser/hosted-viewport-parity-fix.spec.ts \
  test/browser/hosted-update-policy.spec.ts --reporter=line,json
# REQUIRED: body-green is insufficient; currently exits 1 on three real shutdown failures.
node scripts/verify-hosted-browser-results.mjs /absolute/playwright.json
HOSTED_EXCALIDRAW_TGZ=/absolute/plugin.tgz HOSTED_STRESS=1 \
  npx playwright test test/browser/hosted-stress.spec.ts
```

Normal desktop preparation remains `npm run desktop:prepare` followed by `npm run desktop:package -- --dir` on the actual target OS. Never relax CSP, signatures or ownership locks to manufacture passes. Protocol `0.2.0-dev.1` remains verification-only; release guard unchanged. No publication, push or release merge.
