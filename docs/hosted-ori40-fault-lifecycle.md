# ORI-40 — bounded local fault and resource-lifecycle acceptance

This supplements, **not replaces**, [the A01–A25 matrix](hosted-production-acceptance.md). No npm publication, push, release merge, shared-alpha edit or parent-worktree mutation. Dedicated sibling `pi-webapp-ori40`, branch `ori-40-fault-lifecycle`, base `683a4a3`. Plugin source unchanged; exact supplied local development archive SHA256 `932c697f49d87855d5ddc46786c9d0d8ee7b52f64f95af266c46d18ce84d53d5` (15,643,698 bytes).

## Product changes and fault evidence

- **A12:** The actual authenticated management route and UI now support `downloadId` plus `cancel-download`. UI generates an exact UUID per install/update/check; cancellation is outside the lifecycle queue and must match both plugin and pending request. Another request's nonce is rejected. No broad cancellation of other operations, active worker, editor flush, or accepted installation. A successful cancel request means cancellation **requested**, never rollback proof; the original operation response and refreshed inventory decide the final outcome. No automatic retry.
- Cancellation aborts metadata/archive download and precommit staging; a committed immutable installation remains installed. If cancellation races commitment, inventory may contain the fully verified package. Installer cancellation actively cancels its stream reader and removes its abort listener in `finally`; timeouts use the same path. The index remains the sole installed source of truth; inert uncommitted orphans retain existing recovery semantics.
- Management install/update failures persist a visible failed diagnostic. UI explicitly distinguishes cancellation requests from rollback. Real UI/HTTP tests cover partial-stream interruption and cancellation, refreshed inventory, old digest/manifest equality, and candidate refusal. Node management tests additionally inject `ENOSPC` at the **second real staging write** via the Node filesystem boundary, restore the mock, and verify staging cleanup, old worker invocation/version/generation, unchanged old bytes, and no candidate registration. This is **not physical disk exhaustion**. No candidate worker is launched before verification/commit.
- **A14/A16:** Reused the existing real child SIGKILL tests at forked/prepared/committed/cleaned and hard pair-owner recovery, rather than reimplementing them. Extended committed/cleaned assertions: accept newer-generation state and file bytes, reject an old-generation writer even with the newest file hash, reject a late response carrying an old hash, recover again, and compare final actual file bytes/hash. An initially reused request ID correctly hit the stronger replay guard; the final test uses a distinct late-response ID to independently exercise the file-hash fence.
- **A15:** Extended real candidate-health SIGKILL to occur **after version 0.2.0 has replaced 0.1.0 and accepted newer edits**. Failure keeps the 0.2.0 worker/pointer/state/file, not the 0.1.0 snapshot. Existing unsupported-schema refusal remains explicit and retains latest state. This does not claim general reverse migration, automatic Restore, or power-loss durability beyond the existing journal model. Stopped-owner confirmation/byte-fingerprint recovery remains mandatory; no TTL lock stealing.

## A20/A25 — actual different-version editor lifecycle

`test/browser/hosted-stress.spec.ts` extends the existing 70-cycle test: 20 warmups + **50 measured** different immutable local versions (`0.1.1`…`0.1.70`) of the exact real plugin payload. Versions are synthetic local test releases, not public releases or different implementation/schema revisions. Full host App + retained SDK + real HTTP + real worker, **controller/tool/editor** realms, native 100-element scene with Chinese text and viewport. A deterministic SDK provider stub performs no external model call. The native initial normalization is accepted before hashing; subsequent full checkpoint/revision hashes must remain unchanged. Every measured switch includes initialized views and a visible interactive editor canvas.

Test-only instrumentation is installed before application code and observes actual browser primitives; it does not synthesize acknowledgement, clear registries, or dispose application resources:

- 210 disposed realm reports (3 × 70) have **zero plugin intervals and zero watched window listeners** at actual `MessagePort.close`. Watched names are message/compositionstart/compositionend/pointerdown/pointerup/pointercancel/pagehide; this is not an exhaustive DOM-library listener census.
- Actual parent MessageChannel port1 `start`/`close` observed; exactly **3 started/live ports** remain, no accumulation. The separate React scheduler channel is not misreported as a hosted port. Frame context destruction observed via CDP: **840** contexts (includes browser isolated worlds; not 840 editor realms).
- WeakRef census after GC: **zero detached old iframe elements** at every measured sample. Does not prove absence of all possible parent references. No strong DOM/window/port references are retained by the parent probe.
- 70 old worker PIDs actually exited; six unique tool descriptors, same retained session and parent boot, exactly two accepted state/code versions remain. No page errors or external browser requests.

### Reference results

macOS arm64 Darwin 25, Apple M1 Pro / 8 logical CPUs / 16 GiB; Node 24.21.0; Chromium 153.0.8010.12. This is a shared local reference run, not an idle-machine benchmark.

| Measurement | Result |
| --- | --- |
| Switch, 50 measured samples | P50 **695.63ms**, P95 **753.54ms**, max **777.20ms**; unchanged target P95 <=2000ms |
| Initial archive verification/extraction/install | **292.87ms** |
| 70 subsequent local installs, excluding synthetic archive generation | P95 **300.99ms** |
| Separate real loopback HTTP/TCP transfer | **15,643,698 bytes / 29.23ms**, byte-for-byte equality; **not registry/internet latency** |
| Browser post-GC heap, first/last ten-sample medians | **19,808,776 → 20,832,828 bytes**, growth **1,024,052 bytes** |
| Parent RSS (50 samples) | **510,918,656–652,623,872 bytes**, last **643,956,736** |
| Worker pre-switch RSS (70 `ps` samples) | **54,912–58,192 KiB** |

Full numeric samples, cumulative parent CPU and per-child `ps pid,time,%cpu,rss` records are in `artifacts/ori40/reference-measurement.json`. Child CPU is cumulative process time and lifetime percent at a pre-switch instant, **not precise switch CPU or peak RSS**; sampling can miss transient peaks. Parent CPU includes local repacking/installation, not just switches. Heap growth is observed and nonzero; the existing smoke budget is unchanged, **not a strict long-term no-leak proof**. Registry latency is unmeasured, and synthetic archive generation is outside switch/install timers.

### Retained adverse results and probe correction

All initial failure logs are retained. Attempts 11–13 completed all 70 cycles but exposed one detached generation-1 tool iframe. Heap snapshots show its direct root `(Global handles) → DevTools console`, not an application owner. `Runtime.discardConsoleEntries` alone did **not** release that remote iframe handle. Final runs activate the same real Edit button via its DOM click in the parent evaluation instead of retaining a Playwright remote iframe query handle. The zero-detached-frame assertion stays **zero**; no count allowance or relaxed SLO. Final interaction still calls the production button handler/host open-panel route. Native pointer/focus behavior remains covered by the full production suite, but this GC census intentionally avoids the debugger's artificial strong handle. Failure snapshots are supplied for independent inspection; do not silently classify them as application leak proof or suppress them.

Other retained initial failures: unstarted coordinator in the first fault fixture, missing stress workspace/right-sidebar setup, supplying native elements to the tool's skeleton-only input, unaccepted candidate, pre-native-normalization checkpoint baseline, global React scheduler port counted as hosted, TypeScript Node/browser overload mismatch, and isolated `npm ci --ignore-scripts` missing node-pty preparation. Fixture/probe/setup fixes did not weaken identity/CAS/scene/flush assertions. `npm rebuild node-pty` ran only in this dedicated worktree.

## Final executed validation

- `npm run check`, `npm run build`: PASS.
- Full Node: **410 pass, 0 fail, 1 Windows-only skip**. Desktop Node: **94 pass, 0 fail**. Exact external archive and pair tests supplied their exact hash, not skipped. No plugin source modification/rebuild needed.
- Complete relevant Chromium suite: **19 pass, 1 obsolete diagnostic skip, 0 failures/retries/flaky**, including original parity/production/transport/viewport/policy, new real management cancellation/interruption, and the 70-cycle stress. Strict clean-body/shutdown result gate PASS. Subsequent standalone final stress with separate loopback timing PASS; teardown preserved.
- Logs include failed attempts and successful teardown; source handoff includes full committed repository archive and patch. No all-A01–A25 claim.

## Reproduce

Use the exact supplied TGZ and SHA above. In this independent checkout:

```sh
npm ci --ignore-scripts
npm rebuild node-pty
npm run check && npm run build
HOSTED_EXCALIDRAW_TGZ="$TGZ" ORI38_EXCALIDRAW_TGZ="$TGZ" \
HOSTED_EXCALIDRAW_SHA256="$SHA" ORI38_EXCALIDRAW_SHA256="$SHA" npm test
HOSTED_EXCALIDRAW_TGZ="$TGZ" HOSTED_STRESS=1 \
PLAYWRIGHT_JSON_OUTPUT_FILE=artifacts/ori40/browser-results.json \
npx playwright test test/browser/hosted-stress.spec.ts \
  test/browser/hosted-download-cancel.spec.ts test/browser/hosted-production.spec.ts \
  test/browser/hosted-parity.spec.ts test/browser/hosted-transport.spec.ts \
  test/browser/hosted-viewport-parity-fix.spec.ts test/browser/hosted-update-policy.spec.ts --reporter=line,json
node scripts/verify-hosted-browser-results.mjs artifacts/ori40/browser-results.json
```

## Remaining release gates (not additional implementation approval requests)

Strict long-duration leak/peak-resource proof; diverse actual future plugin implementations and schemas; real internet/proxy/registry cancellation and postcommit race UX matrix; ENOSPC at all metadata/rename/fsync boundaries and physical full-disk behavior; OS power-loss/uncertain-save; native IME/dialogs; Windows/Linux/macOS x64 and non-Chromium certification. This issue delivers the authorized bounded local gaps and explicitly hands these residual release gates to the parent integration matrix. It neither certifies all platforms nor promises generalized reverse migration.
