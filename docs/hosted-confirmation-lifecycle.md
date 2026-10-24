# ORI-37: real removal confirmation and explicit lost-view reconciliation

## Isolated handoff

Host baseline `4c0ebbd`, plugin baseline `6108c6b`. Dedicated worktrees `pi-webapp-ori37` and `pi-extensions-ori37`, branch `fix/ori37-lifecycle` in each repository. No shared alpha/parent source edits, push, publishing, release merge, CSP changes, storage reset, TTL, synthetic acknowledgement or automatic Restore.

## Normal authoritative removal

`useHostedTranscript` keeps the previous React projection mounted when an authoritative snapshot removes a hosted call. The old projection's hosted tool owners retire as one boundary: wait for initialization, invoke the original realm's real `freeze` (which flushes and makes the plugin root inert), submit clean status only after that RPC succeeds, and close the exact mount/generation/token capability. Only after all closes succeed can the latest queued history replace that projection. Retiring the complete old tool projection prevents an additional removal arriving during a pending close from slipping through the gate. Editor/controller owners are not retired by this boundary.

Tool-call incarnations advance atomically after all real closes, so a provider reusing the same call ID after an actual absence cannot revive the closed capability. A partial failure keeps the old owners mounted, reports a recovery error and offers Retry; it does not remount successfully closed siblings while another close is uncertain. This may recreate retained **tool previews** at a removal boundary, but does not recreate the parent document, retained SDK session, editor or controller.

The plugin now sends its actual initial status from `initialize`, rather than leaving a healthy newly initialized realm unknown until the 150ms status timer happens to run. This is measured plugin status, not a host-invented clean acknowledgement. Shutdown still performs the real freeze barrier.

## Abrupt reload: explicit reconciliation, not a handoff claim

A per-tab sessionStorage journal records exact registered capabilities (including kind/content ID). Successful real close removes the matching record. A replacement document displays the previous document's unconfirmed capabilities separately, including generation and mount/content identity.

The journal is **not** a draft/checkpoint identity, proof of a latest draft, a server-wide lost-view list, or a guarantee of recovery if browser storage is unavailable/lost. A copied tab journal is also not liveness evidence. Missing capabilities remain fail closed; this change never enumerates/clears registrations or guesses that a newer revision supersedes them.

For the supported reload recovery path, the plugin's existing local-backup, Download draft and explicit Restore UI remain separate. The host warning says that the latest edits are unacknowledged, asks the user to rescue/download first, warns of permanent loss if the latest draft is inaccessible, and requires a separate explicit discard decision for **each** exact old capability. There is no bulk discard or automatic Restore. Native losing geometry is downloaded before reload in the browser regression; Restore does not dismiss the old capability warnings.

The additive `discard` operation is not a flush acknowledgement and does not mark any view clean. It removes only the confirmed, authenticated owner/workspace/session/mount/generation/token registration. It refuses active barriers and in-flight capability actions. Ordinary iframe actions now require a still-registered capability too; discarded and old-generation capabilities cannot write. Existing trusted host/v1 action calls without a view capability remain compatible. Generation/CAS/flush-action allowlists are retained.

## Parent integration / vendor synchronization

Integrate **both** host and plugin commits and rebuild the plugin archive; do not combine this host change with the previous archive and claim full lifecycle acceptance. If the parent keeps a vendored/local Excalidraw archive, it must synchronize that archive to the rebuilt plugin payload and its integrity metadata. The new JSON operation lives in the host's `src/contracts/hosted-plugins.ts`; the external `@chengzhiyi/pi-web-protocol` package and protocol-1 MessagePort DTOs did not change, so no protocol-package vendor bump is required. This is a local development payload, not a published new immutable 0.1.0 release.

## Verification and adverse findings

- Host check and build: PASS. Existing build warnings retained.
- Related Node suites: **77 passed, 3 skipped, 0 failed** (80 total). Added tests cover unknown-view fail-closed, per-item scope/confirmation, active-action refusal, revoked action rejection, retryable retirement and deferred real close.
- Plugin check/build: PASS; plugin Node suite **17/17 passed**.
- Final focused built-App Chromium run: **5/5 passed, zero shutdown-failed-closed annotations**: original progressive/actual-removal body, new network-close-failure + retained-original-realm/retry body, original competing dirty-window recovery with per-item explicit reconciliation, and **both unchanged production lifecycle bodies (1440/390)**. The progressive test holds the actual close HTTP response and proves the original iframe is still attached, then proves a different realm mounts after real completion. No successful flush or close is mocked.
- The parity helper retains teardown failure annotations/attachments and now **rethrows** shutdown errors. Body success can no longer hide a lifecycle failure.
- Final wider browser run: **11 passed, 2 failed, 1 skipped** (14 total), consistent with two earlier runs before adding the negative recovery body. No shutdown-failed-closed annotations. The two failures are preserved, not waived: A06 samples an earlier viewport checkpoint and later observes a newer pan/zoom checkpoint after freeze; labeled A09 expects revision 1 while the real preview reaches revision 2 with the same candidate identity. These assertions were not loosened; this handoff does **not** claim an all-green parity suite or establish those body failures as pre-existing. They require parent triage separate from the two lifecycle gates, which now pass.
- `test/browser/hosted-production.spec.ts` is byte-unchanged from baseline; `git diff --check`: PASS.

Local rebuilt plugin archive SHA-256: `932c697f49d87855d5ddc46786c9d0d8ee7b52f64f95af266c46d18ce84d53d5`.

```sh
npm run check
npm run build
node --import ./test/setup-env.mjs --experimental-strip-types --test --test-concurrency=4 test/hosted-*.test.ts test/conversation-turns.test.ts
HOSTED_EXCALIDRAW_TGZ=/absolute/path/to/rebuilt-local.tgz npx playwright test test/browser/hosted-parity.spec.ts test/browser/hosted-production.spec.ts --grep 'progressive arguments|competing real windows|close network failure|retained SDK hot lifecycle' --reporter=line,json
HOSTED_EXCALIDRAW_TGZ=/absolute/path/to/rebuilt-local.tgz npx playwright test test/browser/hosted-parity.spec.ts test/browser/hosted-production.spec.ts test/browser/hosted-transport.spec.ts --reporter=line,json
```

The wider command is intentionally reported nonzero for its two unweakened body assertions. No browser/OS matrix certification or lossless recovery from arbitrary destroyed realms is claimed.
