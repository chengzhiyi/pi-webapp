# ORI-39 — bounded native compatibility regression

## Handoff and authority

Local-only implementation and verification of A04/A05/A06/A14/A21/A24. **Not A01–A25 release approval.** No publication, push, release merge, parent/shared-alpha source, dependencies or build outputs were changed.

- Host branch `test/ori39-native-compat`, sibling `pi-webapp-ori39`, based on `683a4a3d7dd1f71e2e80962a2fc5e88043253f2c`.
- Host product fix `7e60f42`: preserve server `errorCode`/`reason` through HTTP → frame RPC, with a unit regression for flat and nested wire errors.
- Plugin branch `test/ori39-plan-archive`, sibling `pi-extensions-ori39`, based on `b8f74b1`; product fix **`c1827f2`**: missing historical drawings require explicit recovery. Cherry-pick the plugin fix as well as the host commits; the browser migration test intentionally requires both fixes.
- The supplied baseline development tgz was used for initial regressions (SHA-256 `932c697f49d87855d5ddc46786c9d0d8ee7b52f64f95af266c46d18ce84d53d5`). Final verification uses the independently rebuilt fixed plugin below. Neither archive is published.

## Exact local artifacts

| Archive | SHA-256 |
| --- | --- |
| Fixed `@chengzhiyi/pi-excalidraw@0.1.0` | `b9a921d1a8e6021cae0236ed86d51706919adbef70e47b671b62832b90c634bd` |
| Actual independent `@chengzhiyi/pi-plan-mode@0.1.0`, protocol-v1 manifest | `159bb5d01e8d6a8fadfdb9ff210bafaa6d25a6b13b40ad49720d2fbe35c03858` |

Plan source and its bundled extension/client/CSS came from the existing `packages/plan-mode` at plugin base, not a synthetic manifest. Both packages were built and packed in the task's isolated extension worktree. Its existing frozen lockfile did not cover Excalidraw; the initial frozen install and initial build-before-protocol failure are retained. An isolated `pnpm install --no-frozen-lockfile --ignore-scripts`, then protocol/plan builds resolved this; the actual resolved lockfile is included in the evidence, not silently substituted into the parent's repository. The compiled v1 extension resolves SDK peers from the isolated host install and executes on the real SDK 1.3.0.

## Executed coverage

### A04 / A21 — actual v1 and v2 coexistence

`test/browser/hosted-plan-v1.spec.ts` extracts the actual v1 tgz, discovers its catalog and runs the real extension factory and `/plan on` registered command through the retained SDK. The complete host renders the real plan-review component and resolves its approval interaction. This approves **only the fixture plan inside the isolated test session**, not any platform release or task gate.

After the request settles, plan mode remains on. The actual Plugins UI installs and enables the v2 worker. An attempted drawing write remains excluded from the plan's active SDK tool set, produces `Tool ... not found`, and creates no drawing. The real v1 browser mode-control action exits plan mode. An execution-time empty host allowlist then rejects a deliberately reactivated drawing definition with `host policy`, still without creating data. One SDK object and parent-page boot identity remain unchanged. This is not just manifest compatibility.

**TUI limit:** the actual registered command/factory and SDK extension lifecycle were exercised; no physical terminal, terminal key events, interactive TUI picker, or OS IME is claimed. Existing `hosted-agent-policy.test.ts` real `mountTui`/nested/direct policy regressions also pass in the full Node run.

### A05 — streaming + pending old batch + two real same-profile windows

`test/browser/hosted-stream-multiwindow.spec.ts` opens two complete App documents/editors in one Chromium context, with a foreground and a retained background SDK object. Its deterministic local provider transport emits **128 actual SDK stream deltas / 33,938 characters**. It keeps streaming while two authenticated window update requests compete and while the real admission barrier is frozen. This is **not a remote-model/network acceptance test**, nor a multi-minute streaming stress test.

An explicitly labelled **synthetic local 0.1.1 fixture** retains the real backend/editor/store but adds a required `ori39Schema: 2` field to `diagram_read`. The wrapper and resource-manifest rehashing are in `test/helpers/hosted-schema-release.ts`; integrity checks are not disabled. The actual generated tgz and its recorded digest are attached to the final test report.

Final executed trace: old generation **1 / PID 31909** executed both pending old-schema reads; a held first invocation prevented retirement of that worker. A direct request on the other retained SDK did not reach its provider until thaw; its provider received the new required schema and its real tool call succeeded on **generation 2 / PID 33259**. Stream plus drain took **2,593ms** in this run (an observation, not a latency target). Both management requests returned 200. There were **zero AgentSession dispose/reload calls**, unchanged page boot identities, and real acknowledged shutdown of all remaining realms.

### A06 / A14 — native mixed scene, not backend echo

`test/browser/hosted-native-compat.spec.ts` uses the native Open/file-chooser UI to import exactly **100 elements**: 96 grouped/colored shapes, Chinese text, pressure-bearing freehand points, an ellipse and a bound arrow. It performs actual native select-all/movement, fit-all, zoom/pan and Chinese-path workspace save. It checks text, freehand points and arrow endpoint identities, then switches generation with real flush/reopen.

Both native **canvas backing pixel PNGs** must match exactly (no overlay toolbar screenshot substituted for canvas data). The full scene is canonicalized recursively by sorted object keys, retaining array order and every field; SHA-256 and revision must be identical across generation. No fields are dropped to manufacture parity. A DOM screenshot initially differed because the intentionally cleared undo toolbar overlays the canvas; that adverse run is retained.

Actual old-generation `sync` and `save` arguments are captured before switching and delivered after the commit. Both return 409. The native saved file and **all active checkpoint file bytes** remain identical. This covers delayed **actions**, not every possible JavaScript callback ordering.

### A24 — old history/checkpoint/localStorage and explicit recovery

`test/browser/hosted-history-migration.spec.ts` seeds an old scoped checkpoint (revision/savedRevision 7, original native file/path/hash), old transcript tool calls/results with the original ID, deliberately misleading old tool arguments, and original-key same-origin localStorage backups. Real old cards resolve through the hosted contribution/`diagram:` alias into the native editor.

The existing drawing retains authoritative x=91 rather than reconstructing x=9999 from old arguments or auto-restoring local backup x=777. Only clicking Restore changes it. After initial import the test deliberately mutates the old source checkpoint to x=-999; a new generation still uses the already accepted hosted x=777 and leaves the old source/native saved file unchanged. There is no second import.

A separate missing historical ID returns 404 and shows honest unavailability. Opening Recovery options does not create anything. Download yields the retained local backup; only **Restore backup as new drawing** imports it into a distinct new ID. The missing ID stays 404 and its original localStorage backup remains intact.

## Product findings fixed

1. Server errors are flat `{ error, errorCode, reason }`, but the client read only nested `error.code/reason`. The plugin therefore received a generic `host_error`, repeatedly polled missing drawings and exposed an inappropriate Edit button. Preserve the actual structured error at the host boundary; do not infer unavailability from arbitrary translated text.
2. The missing-editor route automatically issued `new`, silently replacing old history with a blank drawing. It now explains the absence and requires explicit Download/Restore-as-new/Create-blank actions. No automatic Restore, new latest scene, TTL, fabricated flush acknowledgement, or destructive backup cleanup was added.

## Final verification and retained adverse evidence

- Host `npm run check` and `npm run build`: PASS.
- Node: **408 pass / 0 fail / 1 Windows-only skip**; desktop: **94 pass / 0 fail**. Total **502 pass / 1 skip**. Exact fixed archive and independent hash pins supplied to archive/bootstrap/pair tests.
- Plugin check/build: PASS; plugin tests **17/17** PASS.
- Complete Chromium suite including new four cases, existing production/parity/transport/viewport tests and policy case: **20 clean body + real shutdown passes, 0 failures, 1 named obsolete diagnostic skip**. No retries, shutdown annotations or hidden teardown failures. `verify-hosted-browser-results.mjs` exits 0.
- Earlier failures are retained as raw logs/JSON, not counted as passes: missing-history regression exposing the wire bug; DOM-overlay pixel mismatch; test setup/selector/API-key/schema-snapshot issues; synthetic tar's macOS extended headers rejected by the unchanged archive validator; an early secondary fail-closed shutdown after mounted-session setup switching. The final test creates retained sessions before browser realm mounting; it does not certify that separate mounted-session-switch scenario.
- Initial full Node run had **407 pass / 1 fail / 1 skip**: real PTY `posix_spawnp failed` following the isolated scripts-disabled dependency installation. `npm rebuild node-pty` in **this worktree only**, followed by `desktop/check-pty.cjs`, repaired the local native fixture; the complete rerun above passed. No product boundary or test was skipped to hide it.

The evidence bundle includes source patches/full changed source, exact package archives, synthetic archive, raw success/adverse reports, frame diagnostics, native canvas images, plan/stream/checkpoint JSON evidence, dependency resolution and check/build/test logs.

## Reproduction

Build/pack in your own isolated plugin checkout, never a parent worktree:

```sh
pnpm install --no-frozen-lockfile --ignore-scripts
pnpm --filter @chengzhiyi/pi-web-protocol build
pnpm --filter @chengzhiyi/pi-plan-mode build
pnpm --filter @chengzhiyi/pi-excalidraw check
pnpm --filter @chengzhiyi/pi-excalidraw build
pnpm --filter @chengzhiyi/pi-excalidraw test
# Pack each package into an isolated artifact directory; do not publish.
```

Host:

```sh
npm ci --ignore-scripts
npm rebuild node-pty
npm run check && npm run build
# Set TGZ, SHA and PLAN to the supplied, independently checksum-verified local archives.
HOSTED_EXCALIDRAW_TGZ=$TGZ ORI38_EXCALIDRAW_TGZ=$TGZ \
  HOSTED_EXCALIDRAW_SHA256=$SHA ORI38_EXCALIDRAW_SHA256=$SHA npm test
HOSTED_EXCALIDRAW_TGZ=$TGZ HOSTED_PLAN_V1_TGZ=$PLAN \
  PLAYWRIGHT_JSON_OUTPUT_FILE=artifacts/browser.json npx playwright test \
  test/browser/hosted-native-compat.spec.ts test/browser/hosted-plan-v1.spec.ts \
  test/browser/hosted-history-migration.spec.ts test/browser/hosted-stream-multiwindow.spec.ts \
  test/browser/hosted-parity.spec.ts test/browser/hosted-production.spec.ts \
  test/browser/hosted-transport.spec.ts test/browser/hosted-viewport-parity-fix.spec.ts \
  test/browser/hosted-update-policy.spec.ts --reporter=line,json
node scripts/verify-hosted-browser-results.mjs artifacts/browser.json
```

## Not claimed / parent integration

Parent task owns integration of these local commits and release decisions. This issue does not add platform/pressure certification: no OS terminal key coverage, OS IME/native dialogs, real remote provider, power loss, arbitrary destroyed-history recovery, long-term streaming/resource stress, other browser engines, or cross-platform packaged app verification. Existing platform/resource gaps stay explicit in the parent matrix; this bounded local assignment has no remaining implementation dependency.
