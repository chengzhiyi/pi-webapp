# ORI-41 follow-up — repaired locally, environment gaps explicitly skipped

## Current scope and verdict

The user's 2026-10-25 comment `039ed747-dd9b-4796-9a14-419138519404`
requests fixing actual failures and checking GitHub capability; unavailable
platform testing may be skipped. This replaces the earlier requirement to keep
waiting for missing native runners. It does **not** approve publication or make
untested targets pass. Work is complete against that revised scope, not blanket
A01–A25 or all-platform certification.

Historical failures, including WebKit crashes, remain in
`docs/hosted-platform-acceptance-ori41.md` and the earlier evidence attachment.
This follow-up supersedes their current disposition, not their historical data.

## Source, artifact and containment

- Host: independent `test/ori41-platform-matrix`, starting from `9739d1b`
  (original supplied base `683a4a3`).
- Plugin: independent sibling `pi-extensions-ori41`, branch
  `fix/ori41-browser-native`, commit `151acee`, base `b8f74b1`.
- Final **new local development** 0.1.0 tgz SHA256:
  `d000ae308936b60e6bfeff05a988e6fce8df05df8f649efd6a1900587cf16088`.
  It has 427 controlled resources. The original supplied archive SHA256
  `932c697f49d87855d5ddc46786c9d0d8ee7b52f64f95af266c46d18ce84d53d5`
  was not overwritten. This final archive must be paired with this host patch;
  its private download relay is not supplied by older host builds.
- No parent/alpha source or build outputs changed. Plugin dependency resolution
  initially used a read-only dependency link; this was replaced with a private
  copied tree, then rebuilt and retested. Independent copied-closure build also
  passes. No dependency files in the shared tree were patched.
- No push, CI dispatch, new cloud runner, release merge, registry publication,
  signing-policy change, notarization, or accessibility/input-source change.
  App-dir build uses existing ad-hoc signing, not public distribution.

## Diagnoses and repairs

1. **Firefox canvas keyboard routing**: pointer-down on a non-focusable canvas
   leaves body focused. Native Excalidraw keyboard handling is intentionally
   scoped to its container. Focus only that container on canvas pointer-down;
   do not capture input fields or the parent composer. Geometry, zoom/pan and
   undo/redo are tested through actual keyboard/pointer events and stored scene
   assertions, not injected scenes.
2. **Firefox downloads**: iframe blob links are treated as frame navigation and
   blocked by the parent's existing CSP. A private identity-bound MessagePort
   relay lets the top document download the Blob. Only editor/workspace mounts
   can use it; validate bounded Blob/type/extension/safe filename, no remote URL
   or filesystem input. Vendor JSON MIME is normalized at the plugin adapter;
   desktop allowlists, sandbox and CSP stay unchanged. Upstream fallback code
   is adapted at build time with a pinned SHA, not modified in node_modules.
3. **Same-profile Firefox multiwindow**: concurrent cacheable GETs for the same
   never-ending NDJSON URL stall the second document. `cache: "no-store"` on
   stream fetch prevents cache-entry serialization. Existing multiview and
   aggregate-transport assertions now pass without independent-profile masking.
4. **Lost ACK recovery**: a failed ACK stops that view's reader, retaining its
   frozen realm and uncertain command. Add an explicit `Retry view connection`
   action, including visible errors/retry for hidden controllers. Retry reads
   and replays the same identity-bound command ACK, reusing the already-frozen
   snapshot; it does not fabricate an ACK, auto-Restore data, clear registries,
   or auto-retry failed writes. Native probe waits for actual successful resume
   ACKs from BOTH retained mounts before explicitly requesting a new switch.
5. **Teardown readiness race in tests**: a persisted result may precede the
   realm's genuine HTTP busy=false report. New-argument/result and candidate
   tests could finish their bodies while the replacement frame was initializing.
   Wait for actual registered-realm readiness, bounded to 10 seconds, before
   normal shutdown. Readiness timeout remains a failure; actual shutdown/freeze
   is attempted even if that assertion fails. Real teardown remains mandatory.
6. **Native smoke precision**: assert that arrow movement actually changed x
   before undo, and undo restores the original x. Revision changes from drawing
   alone no longer accidentally satisfy the movement precondition.

## Final verification

All browser and native rows below use the final tgz hash above.

| Check | Result |
| --- | --- |
| Firefox 155, macOS arm64, full matrix | 17 PASS, 1 obsolete legacy diagnostic SKIP; real shutdown gate clean |
| Chromium, macOS arm64, full matrix | 17 PASS, 1 obsolete legacy diagnostic SKIP; real shutdown gate clean |
| Combined browser lifecycle verifier | 34 clean body + shutdown PASS; 2 diagnostic SKIP; 0 failures |
| macOS arm64 Electron 44.9.0 packaged baseline | PASS draw, moved geometry, undo/redo, Chinese inserted text (NOT OS IME), workspace save, PNG bytes, generation reopen, disable/reenable, retained scene/file/session/process identities |
| macOS arm64 packaged lost-ACK recovery | PASS composer isolation; injected real view-ACK HTTP 503 refuses switch and retains exact realm/scene/generation; explicit reader retry receives real resume ACKs; subsequent switch succeeds and retains scene/session/backend+worker PIDs |
| Native cleanup | Both probes exit 0 only after app close and nonce-stopping their owned isolated backend; no shared backend terminated |
| Normal desktop prepare + app-dir package | PASS; initial retry needed after official Node checksum request timed out (failed log retained) |
| codesign deep/strict verification | PASS; ad-hoc, not notarized |
| Host TypeScript | PASS |
| Host Node suite with explicitly pinned original tgz + paired-update fixture | 409 PASS / 1 Windows-native SKIP (410 tests); original-archive backward compatibility retained |
| Desktop unit suite | 94 PASS |
| Plugin TypeScript / unit / resource verification | PASS / 17 PASS / PASS |
| Independent copied-closure plugin build | PASS |

Early experiments and failures are retained in evidence, not reported as passes.
An extra full-suite run supplied the original tgz without its digest override;
its linked-update test correctly rejected a stale default fixture hash. The
final run supplies both recorded digest overrides and passes. No assertion was
removed to bypass that integrity check. Browser readiness failures before the
synchronization repair are retained in `browser-before-*.json` and logs.

## GitHub capability discovery and explicit skips

Used `connections_search` through the injected runtime connection endpoint.
Saved GitHub connection `f6d8f99e-f663-47c8-b910-d71bd1eae74f` was ready for this
agent. Read-only GitHub queries verified Actions enabled and these active
workflows in `chengzhiyi/pi-webapp`:

- `368030667` — CI and npm publish
- `390613284` — Desktop prerelease
- `390594265` — Desktop packages (manual)

The manual desktop workflow targets `macos-latest`, `ubuntu-latest`,
`windows-latest`, running npm ci/check/desktop unit tests/prepare/package and
uploading unsigned installers. It does NOT run this task's packaged GUI probes,
provide human IME/dialog receipts, or include this unpublished local host/plugin
pair. Running unrelated default-branch packaging would not be valid acceptance
of these sources. Installing a new workflow/staging the local pair would require
external writes beyond the preserved no-push/no-dispatch boundary. None were
performed. Read-only capability evidence: `github-capability.json`.

Per the user's fallback, these are **SKIPPED / not certified**, not PASS:

- Actual Windows x64, Linux x64 and macOS x64 packaged-app GUI acceptance.
- OS-native Chinese IME and native chooser cancel/overwrite/focus on all targets.
  Browser filechooser injection and Electron fixed save destination do not
  substitute for those human-visible interactions.
- WebKit/Safari: official WebKit revision 2359 still segfaults creating even an
  empty standalone page, before product navigation (`webkit-runtime.log`).
  No evidence of a product-page failure or a Safari pass; runtime capability
  unavailable, skipped under the latest direction. No browser guard weakened.

## Reproduction (local only)

From the isolated host worktree after build:

```sh
export HOSTED_EXCALIDRAW_TGZ=../pi-extensions-ori41/artifacts/ori41-fix/chengzhiyi-pi-excalidraw-0.1.0.tgz
export HOSTED_EXCALIDRAW_SHA256=d000ae308936b60e6bfeff05a988e6fce8df05df8f649efd6a1900587cf16088
npm run check
npm run build
PLAYWRIGHT_JSON_OUTPUT_FILE=artifacts/ori41-fix/browser-final.json \
  node node_modules/@playwright/test/cli.js test -c playwright.hosted-matrix.config.ts \
  --project=firefox --project=chromium --reporter=line,json
node scripts/verify-hosted-browser-results.mjs artifacts/ori41-fix/browser-final.json
npm run desktop:prepare
npm run desktop:package -- --dir
export PI_WEB_DESKTOP_EXECUTABLE="$PWD/desktop-release/mac-arm64/pi.app/Contents/MacOS/pi"
node --experimental-strip-types scripts/smoke-hosted-desktop.mjs
node --experimental-strip-types scripts/smoke-hosted-platform.mjs
```

For host Node regression, explicitly use the original `932c697f…` archive with
`HOSTED_EXCALIDRAW_SHA256` and `ORI38_EXCALIDRAW_SHA256` both set to its full
recorded digest, and both archive variables pointed to that original archive.
Pinned original resource-count assertions intentionally remain unchanged.
