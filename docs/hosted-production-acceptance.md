# Hosted Excalidraw — final local integration acceptance

## Verdict and authorization

Authorized local engineering implementation is complete against the revised user scope, **not a public release or all-platform certification**. All ORI-39/40/41/42 deliveries are integrated on `feat/excalidraw-hosted-v2`. No shared-alpha edits, merge into alpha, push, CI dispatch or npm publication were performed by this task.

Current source includes host `c66394c` plus the final evidence/smoke bookkeeping commit; exact final HEADs are in the delivered manifest. Plugin HEAD is `7e5773d` (both ORI-39 historical recovery and ORI-41 focus/download fixes). The current independently built, unpublished 0.1.0 tgz is **15,654,521 bytes**, **427 controlled resources**, SHA-256 **85c142bca9f8baa6f6a64ec993082177233ee7abda49a68b748900540235183d**. This supersedes older archives as the integrated verification artifact, not as an immutable public version.

### Explicit user changes

- ORI-22 comment `50dad8d0-f1c7-4809-af9e-1ccefdc8c028`: no update-strategy configuration; installed official plugins update with the software. Legacy notify/automatic/pinned preferences are migrated, not merely hidden. Manual independent checks/updates remain available. Uninstalled plugins are not installed, disabled plugins are not enabled, compatible higher versions are not downgraded. Open editors stage updates until safely closed; immediate reopening requires the undo-reset warning.
- ORI-41 user comment `039ed747-dd9b-4796-9a14-419138519404`: fix actual failures; inspect GitHub capability, and skip unavailable testing if it cannot supply that capability. Read-only capability discovery found existing workflows cannot validate the unpublished local pair or provide actual GUI/IME/dialog receipts within the preserved no-push/no-dispatch boundary. Windows x64/Linux x64/macOS x64 packaged GUI, OS-native Chinese IME/native chooser interactions and unavailable WebKit are **SKIP, not PASS**. This is a recorded scope exception, not product certification or weakened release guards.

## Joint executed results

| Gate | Current integrated result |
| --- | --- |
| Host check / build | PASS |
| Full Node suite, exact integrated tgz and pinned pair fixture | **424 PASS / 0 FAIL / 1 Windows-only SKIP** |
| Desktop unit suite | **94 PASS / 0 FAIL**; total Node + desktop **518 PASS** |
| Plugin check / build / resource verification | PASS; **17 tests PASS** |
| Independent plugin copied-dependency-closure build | PASS, no host private imports or shared-root resolution |
| Complete hosted Chromium, including actual stress | **32 clean body + shutdown PASS / 0 FAIL / 1 obsolete transport diagnostic SKIP**; strict reporter gate exit 0, no retries/flaky |
| Firefox core matrix, fonts/download/lifecycle | **17 clean body + shutdown PASS / 0 FAIL / 1 same obsolete diagnostic SKIP**; strict gate exit 0 |
| Management UI retained screenshots/CSS checks | **8 PASS**: zh/en × light/dark × 390/1440, full App/HTTP; additional rerun for retained screenshots |
| Normal desktop prepare / app-directory package | PASS, current host source, macOS arm64 |
| Packaged native drawing smoke | PASS drawing, actual moved geometry, undo/redo, inserted Chinese text, Chinese-path save, PNG bytes, generation reopen, disable/re-enable, scene/file/session/backend+worker+shell identities |
| Packaged connection-loss recovery | PASS actual ACK HTTP503 injection refuses switch, retains exact realm/scene/generation; explicit retry obtains real resume ACKs from both mounts; next switch succeeds with scene/session/PIDs retained |
| Packaged signature integrity | PASS deep/strict verification, **ad-hoc, not notarized/public distribution** |
| Clean host tgz, offline scripts-disabled installation | PASS; inspected entire installed dependency closure and built browser/backend payload: **0 drawing dependencies, editor code or drawing fonts**; KaTeX fonts remain unrelated math assets |

Browser installation/update successes use the exact local tgz and deterministic local registry transport. Provider transport is a local fixture driving the real SDK object. They do not claim a public npm install or remote-model test. The production lifecycle tests also assert zero plugin downloads before installation, absent official card, no exposed drawing tools, zero external requests and unchanged SDK/parent identities.

## A01–A25 disposition

| ID | Final local evidence / limits |
| --- | --- |
| A01 | Clean offline installed host archive inspection + actual App absent-card/zero-download assertions PASS. Host has no editor/fonts or default plugin dependency. All-target public artifacts not certified. |
| A02 | Complete browser App/HTTP/worker install-enable-edit-export lifecycle and retained SDK object/boot identity PASS; current macOS packaged PIDs/session/boot invariants PASS. |
| A03 | SDK/TUI policy, direct/nested/codemode/tombstone negatives PASS. Disabled/uninstalled tools cannot execute. |
| A04 | Actual independently packed v1 plan command/factory/review UI/action followed by v2 install PASS; plan and empty allowlist cannot gain write capability. |
| A05 | Real SDK 128-delta/33,938-character fixture stream, pending old-schema batch, same-profile concurrent updates and new-schema admission PASS. No remote-provider or indefinite stream-load certification. |
| A06 | Native mixed 100-element Chinese/text/freehand/bound-arrow/group/background scene PASS; actual edit/save/viewport/switch, complete canonical scene hash/revision and canvas backing pixels preserved. |
| A07 | Held native drag, synthetic composition and dirty flush/composer protection PASS. OS-native IME SKIP under user scope exception, not simulated into a pass. |
| A08 | Default pending until actual editor tab closes, safe application, explicit undo-reset consent and within-generation native undo/redo PASS. |
| A09 | Progressive tool arguments, initial candidate materialization, reject/apply, unlabeled shapes and stale hand-edit protection PASS, including real removed-view teardown/retry. |
| A10 | Source/Open/SVG/white+transparent PNG/save/backup/theme/locale/narrow browser flows PASS; packaged save/PNG PASS. Native file chooser interactions SKIP per user scope. |
| A11 | Same-profile responsive windows, competing CAS, losing geometry rescue/explicit Restore, retained/background sessions and actual lost-ACK reconnect PASS. Destroyed unconfirmed edits are not silently claimed recoverable. |
| A12 | Real UI/HTTP download interruption and identity-bound cancel, partial archive/no execution, hash failures and precise file-layer staging ENOSPC PASS. ENOSPC injection is not physical full-disk/power-loss certification. |
| A13 | Archive paths/links/budgets/integrity/undeclared assets negatives, strict CSP and bounded identity-bound download relay PASS. No security header/permission widening. |
| A14 | Captured old-generation sync/save after commit rejected 409; actual checkpoint/native-file bytes unchanged. Newer confirmed editing survives subsequent failures. PASS bounded fault matrix. |
| A15 | Failed candidate/health/prepare retains old version; unsupported reverse schema preserves latest data and explicitly refuses destructive rollback. PASS defined recovery contract, not arbitrary future inverse migration. |
| A16 | Real SIGKILL across prepare/commit/cleanup and pair-owner recovery PASS. Stopped-owner recovery remains explicit/offline; no TTL lock stealing. Physical power loss outside this bounded test. |
| A17 | Compatible stable selection, no blind latest/downgrade, explicit no-compatible-release diagnostic and manual independent check/update PASS. No user strategy selector or automatic timer invented. |
| A18 | Startup software-linked synchronization, legacy pin migration, disabled/absent/no-downgrade, offline fallback with subsequent retry and controlled npm/desktop business-package pair selection/restart PASS. Supersedes original pin-choice UX. Native OS installer atomicity is not claimed. |
| A19 | Disable/uninstall/reinstall retain .excalidraw, original source and backups; recovered data retain ownership. PASS. |
| A20 | Current 70 different local-version controller/tool/editor/worker cycles PASS: 70 old PIDs exit, 210 clean disposal observations, 3 active ports, final detached iframe references 0, 6 unique tools and 2 retained versions/states. Bounded post-GC growth within smoke budget; not a universal lifetime leak proof. |
| A21 | Actual v1 command/factory/UI, real retained SDK streaming/background paths and mountTui runtime/policy tests PASS. Physical terminal key/picker automation was not performed; does not substitute for these actual adapter tests or certify every SDK version. |
| A22 | Current macOS arm64 sandboxed packaged application PASS bounded native scope. Windows/Linux/Intel Mac GUI, real OS IME and native dialogs SKIP per user's explicit exception. |
| A23 | Current Chromium full hosted suite and Firefox core/fonts/download suite PASS, zero third-party drawing/font requests. WebKit crashes before blank-page creation: SKIP as unavailable runtime; no Safari certification. |
| A24 | Old ID/history card/alias/checkpoint/localStorage one-time migration and explicit restore-as-new/download PASS. Missing history remains 404 instead of fabricating a blank/latest scene. No dual builtin/external registration. |
| A25 | Specified local staged switch, 100 elements, 20 warmups + 50 measurements: P50 **1000.37ms**, P95 **1232.57ms**, max **1319.58ms**, unchanged <=2s target PASS. Separate loopback 15,654,521-byte transfer **36.57ms**, install P95 **785.80ms**; raw child CPU/RSS and browser heap recorded. Not registry/internet latency or cross-platform/held-gesture SLO certification. |

## Retained failures and integration bookkeeping

All historical failed logs are preserved and not counted as passes.

1. First complete Chromium run had 31 passes and 2 skips; strict gate correctly returned exit1 because the opt-in stress row was skipped. Reran the entire suite with `HOSTED_STRESS=1`: 32 passes/1 obsolete diagnostic skip, gate0. The gate was not weakened.
2. First packaged baseline probe expected native `window.confirm`, obsolete after ORI-42's system Modal. It failed before disabling. Updated the probe to visibly locate `Close plugin views?` and click Continue; actual disabled/retained-state assertions pass. Product implementation was not changed to match the old probe.
3. First packaged recovery probe could lose an observed resume ACK when its response arrived before asynchronous decoding of its poll response. The probe now joins independently captured successful ACKs with actual resume commands by exact mount+command identity at assertion time. Both real mount acknowledgements and subsequent successful switch remain required, with no fabricated ACK or sleep-based success.
4. Current relay adds a controlled chunk (427 vs historical 426). Archive census defaults to the integrated 427 and supports an explicit positive integer override for pinned historical fixtures; linked/pair tests still verify exact SHA-256. Resource hash/MIME/path verification remains unchanged.

## Reproduction

```sh
export HOSTED_EXCALIDRAW_TGZ=/absolute/path/chengzhiyi-pi-excalidraw-0.1.0.tgz
export HOSTED_EXCALIDRAW_SHA256=85c142bca9f8baa6f6a64ec993082177233ee7abda49a68b748900540235183d
export ORI38_EXCALIDRAW_TGZ="$HOSTED_EXCALIDRAW_TGZ" ORI38_EXCALIDRAW_SHA256="$HOSTED_EXCALIDRAW_SHA256"
export HOSTED_PLAN_V1_TGZ=/absolute/path/chengzhiyi-pi-plan-mode-0.1.0.tgz
npm run check && npm run build && npm test
HOSTED_STRESS=1 PLAYWRIGHT_JSON_OUTPUT_FILE=chromium.json \
  node node_modules/@playwright/test/cli.js test test/browser/hosted-*.spec.ts --reporter=line,json
node scripts/verify-hosted-browser-results.mjs chromium.json
PLAYWRIGHT_JSON_OUTPUT_FILE=firefox.json node node_modules/@playwright/test/cli.js test \
  -c playwright.hosted-matrix.config.ts --project=firefox --reporter=line,json
node scripts/verify-hosted-browser-results.mjs firefox.json
npm run desktop:prepare && npm run desktop:package -- --dir
export PI_WEB_DESKTOP_EXECUTABLE="$PWD/desktop-release/mac-arm64/pi.app/Contents/MacOS/pi"
node --experimental-strip-types scripts/smoke-hosted-desktop.mjs
node --experimental-strip-types scripts/smoke-hosted-platform.mjs
```

Build only on the target OS. The delivered artifact manifest includes full source snapshots, incremental patches, exact hashes, raw success/failure logs, resource samples and current management screenshots. Earlier per-child reports remain historical independent evidence, not substitute results for this combination. npm registry publication and alpha integration remain separate, unperformed actions requiring their own authority; a visible official catalog card does not make an unpublished package downloadable.
