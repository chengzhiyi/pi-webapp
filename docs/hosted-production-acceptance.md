# Hosted Excalidraw: current implementation acceptance

This is an implementation checkpoint, **not A01–A25 release approval**. User authorization covers engineering work, not npm publication, push or release-branch merge. Shared alpha was not changed. Earlier builtin/CSP failures are historical; the optional-default migration is now integrated.

## Current implementation

- Host `5450e4b` integrates ORI-31: no builtin drawing implementation, tools/API, root editor/converter dependencies, drawing fonts or dedicated build hook. A tiny official catalog/icon and honest old-history recovery remain. Plugin source `5b772fd` includes migration regressions; its runtime tgz is byte-identical to `c54e0b6`.
- The exact prebuilt development archive has 426 declared resources. It retains native Excalidraw, candidates, revision CAS, workspace hash/no-replace saves, opaque legacy migration, Chinese/fonts, local backups and unchanged strict CSP. No registry publication or online provider acceptance is inferred.
- Final physical package/offline consumer tests inspect both Node/browser output and installed transitive closure. Official card is visible absent; startup sends no plugin/font or external requests. KaTeX math fonts and SDK `grok-mermaid` are not Excalidraw dependencies.
- Reference-aware GC preserves current/previous/pending/pin/asset and transaction references; 50 actual different-version process/CAS/directory cycles pass. Unknown recovery references fail closed.

## Production-path defect found by the packaged test

Earlier complete-App fixtures supplied their own `changed` callback, publishing a snapshot. **Actual `pi-host` still published legacy `plugins_changed`, whose client handler reloads the page.** Thus earlier tests did not certify that exact bootstrap notification path.

The production bootstrap now publishes a distinct typed `hosted_plugins_changed` event. Parser/client refresh hosted catalogs through the existing generation mechanism without navigation or Agent reconstruction. Legacy v1 `plugins_changed` retains its existing behavior. A real bootstrap + installed exact tgz + authenticated HTTP + event stream regression asserts activation emits the hosted event, never the reload event. Complete-App fixtures now use that same event.

The desktop shell also rejected **all** downloads, preventing native PNG export. It now allows only PNG/SVG/JSON/Excalidraw blob exports from the current trusted app document and same backend origin, with exact blob URL/name/MIME checks and a native destination/overwrite dialog. Remote/redirected/foreign document/file/data/executable downloads remain denied. This adds no renderer IPC or general filesystem permission.

## Executed verification

- Type checks/build pass. Full host Node **361 pass / 1 Windows-only skip**, desktop Node **92 pass** (including download allow/deny tests). Total **453 pass / 1 skip**. Exact archive and actual-bootstrap notification subtest were supplied, not skipped.
- Chromium complete-App + authenticated HTTP + real worker/tgz + exact retained SDK object at **1440/390px: 2 pass**, under unchanged CSP. Includes absent card, install disabled, enable, real SDK drawing, hand edit/native undo-redo/PNG, Chinese workspace save, pending update, explicit undo warning/reopen, disable/uninstall/reinstall, zero page errors/external requests and stable parent boot identity.
- New complete-host reference test: **20 warmups + 50 measured staged same-version replacements**, real controller realm and worker, 100 elements/groups/Chinese/viewport data preserved by full checkpoint hash, 70 old worker PIDs confirmed exited, six unique tools, one current frame, two state snapshots. Reference M1 Pro/16 GiB/macOS arm64/Node 24.21.0/Chromium 153.0.8010.12: local switch P50 **764ms**, P95 **903ms**, max **994ms**, satisfying the scoped <=2s design target. Archive 15,644,138 bytes; local integrity/extraction ~247ms (not network install time). Host CPU/RSS and all samples are in the task evidence. Post-GC browser medians grew ~768 KiB; this passes an explicit bounded-growth smoke budget, **not proof of zero continuous heap growth**. Active editor gestures, direct port/listener/timer census and child CPU/RSS are not measured here.
- Local **packaged macOS arm64 app-directory** launches with strict ad-hoc signature verification and sandboxed renderer. Cached standalone Node 22.23.3/dependencies were reused after archive-SHA and exact dependency-manifest checks; all host payloads were refreshed. This is not a new network prepare, DMG installation, publisher signature or notarization.
- Baseline packaged smoke passes standalone runtime/PTY/files/shared-browser/update protection/shutdown. Dedicated exact-plugin packaged smoke passes real activation/worker, native drawing/undo-redo, Chinese text insertion and Chinese-path save, PNG completion, generation reopen, disable/reenable with scene/file/host PID/parent boot invariants. Plugin archive is pre-staged by the real installer and host-version marker deliberately fixes offline discovery. Native save destination is fixture-selected, while production download trust checks still execute. It does not inspect an SDK object across process boundaries or certify native OS IME/file dialogs.

## Remaining matrix (scope is not silently reduced)

| Item | Evidence / remaining gate |
| --- | --- |
| A01 | Clean npm-shaped tgz/offline installed closure and actual installed `/web` startup pass; desktop package-directory baseline also runs. Formal all-target release artifacts remain. |
| A02 | Chromium same-object SDK/boot lifecycle and real packaged macOS host/boot PID checks pass. |
| A03 | SDK/TUI direct/nested/codemode/tombstone negatives pass; keep product scope. |
| A04 | Plan/allowlist tests pass; real v1 plan-mode package UI interaction remains. |
| A05 | Retained/background batch drain tests pass; long-provider-stream/multiwindow product matrix remains. |
| A06 | 100-element/group/Chinese/viewport checkpoint hash remains exact in 70 local replacements; complete native visual/gesture matrix delegated. |
| A07 | Busy/flush/IME-synthetic rejection tests pass; full composer-input/composition/drag matrix delegated. |
| A08 | Pending default, explicit undo-reset warning and native undo/redo pass; multiwindow repetitions remain. |
| A09 | New scene/domain candidate stale protection pass; complete hosted stream/apply/reject UI matrix delegated. |
| A10 | Chromium and packaged macOS native drawing/save/PNG/Chinese pass; import/source/transparent/theme/backup comprehensive matrix delegated. |
| A11 | Scope/generation/CAS negative tests pass; complete two-window conflict/disconnect recovery delegated. |
| A12 | Installer/manager negatives pass; broader cancellation/disk-full/network fault matrix delegated. |
| A13 | Archive/resource negatives and strict CSP pass; desktop remote/executable download denial tests added. |
| A14 | Broker/runtime fence actual state/file writes; stale callback E2E expansion remains. |
| A15 | Precommit failure retains old data; unsupported cross-schema migration refuses; generalized schema rollback not certified. |
| A16 | Journal/GC recovery tests pass; exhaustive crash phases and safe abandoned-lock operator workflow delegated. |
| A17 | Compatible stable selection/no downgrade pass; update policy/diagnostic UX delegated. |
| A18 | Startup reconciliation exists; policy/failure retry delegated; full paired app-updater acceptance remains. |
| A19 | Full archive/browser uninstall/reinstall preserves native files and drafts; packaged disable/reenable also preserves bytes. |
| A20 | 50 different-version backend GC cycles and 70 complete-host same-version controller/worker cycles pass bounded checks; long heap/port/timer proof remains. |
| A21 | Real SDK/TUI factories/retained sessions and installed `/web` exercised; broader interactive terminal matrix remains. |
| A22 | Packaged macOS arm64 bounded drawing test now passes. Windows/Linux/macOS x64, native file dialogs and OS IME **NOT RUN**. |
| A23 | Chromium and Electron tested; Firefox/WebKit/other claimed supported browsers **NOT RUN**. |
| A24 | Opaque checkpoint/ID/focus/history/localStorage regressions and absence of dual builtin registration pass bounded tests; comprehensive old-history browser recovery remains delegated. |
| A25 | Specified local staged-switch reference and baseline samples recorded; network install, child CPU/RSS and all-platform SLO matrix **NOT RUN**. |

Follow-ups are actual assigned children ORI-32 (hosted browser parity) and ORI-33 (update/recovery), not requests for repeated implementation permission. Parent integrates their commits and owns final acceptance. No full release pass or publication is claimed.

## Reproduction

```sh
npm run check
npm run build
HOSTED_EXCALIDRAW_TGZ=/absolute/plugin.tgz npm test
HOSTED_EXCALIDRAW_TGZ=/absolute/plugin.tgz HOSTED_STRESS=1 \
  npx playwright test test/browser/hosted-production.spec.ts test/browser/hosted-stress.spec.ts
# Exact published-shaped offline consumer instructions:
# docs/hosted-excalidraw-migration.md
# A locally prepared/signed app on the current target OS, never cross-built:
node scripts/smoke-desktop.mjs --packaged
HOSTED_EXCALIDRAW_TGZ=/absolute/plugin.tgz \
PI_WEB_DESKTOP_EXECUTABLE=/absolute/pi.app/Contents/MacOS/pi \
  node --experimental-strip-types scripts/smoke-hosted-desktop.mjs
```

Normal preparation is `npm run desktop:prepare` then `npm run desktop:package -- --dir`; do not mutate shared caches, skip signature checks, relax CSP or auto-steal locks to make tests pass. Development protocol `0.2.0-dev.1` remains verification-only and its release guard is unchanged.
