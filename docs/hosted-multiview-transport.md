# Hosted multi-view transport — ORI-35 bounded handoff

## Scope and outcome

Branch `fix/hosted-multiview-transport`, based on `aa86769`. No plugin, dependency, installer, manager, update/recovery/storage, desktop, vendor or build source changes. No push, publish or release merge. The exact plugin archive remains SHA-256 `6eee13fe4dab6d68b20d17a0fe68741eba79dc085097149e609678b667c09f31`.

**The same-profile transport defect is fixed. Disconnected-view lifecycle is only partially improved; full lifecycle acceptance is NOT achieved.** Existing dirty/unknown registrations still fail closed. The two remaining plugin body failures belong to the separate plugin slice.

## Root cause: measured, not inferred

Before rebuilding the host with this change:

- The unchanged same-profile parity body failed to display the second window's preview within its original 15-second assertion, with first-window controller/tool/editor polls active.
- A separate Chromium diagnostic logged **44 `SOCKET_POOL_STALLED_MAX_SOCKETS_PER_GROUP` events**, alongside socket allocation/connect events. It intentionally waited three seconds with the second image absent, then closed only the first browser page. The second image appeared within the original diagnostic's three-second release assertion. No server registration was removed, flush acknowledged or timeout extended. That diagnostic's shutdown appropriately failed closed after the lost page.
- Together, Chrome's socket-pool stall events and the controlled connection-release intervention establish origin HTTP/1.1 connection-pool exhaustion for this topology. Raw netlog is private/transient; only socket-pool events without request headers or URLs are delivered.

## Protocol and bounds

`view-poller.ts` owns one scheduler per host document, aggregating registered iframe readers into sequential chunks of at most 64. There is at most one poll request in flight per document; after each complete sweep it waits 250ms. Each request has a five-second abort bound. Empty documents do not poll. Separate windows need no storage lock, leader election or cross-window access token sharing.

`POST /api/hosted-plugins/views` adds read-only `{ operation: "pollMany", views: [...] }`. Only 1–64 poll inputs are accepted; embedded change/ack/close/register operations are rejected. The route forces immediate mode and traverses the existing authenticated `host.views` path for **every** member: retained-session scope resolution plus owner/workspace/session/mount/generation/token binding. Each reply or failure is positional and the browser also checks its view token. One stale capability stops that reader, not unrelated windows. Network failure stops affected readers; there is no automatic replay of writes or recovery of an uncertain action.

Immediate reads return available commands without installing a long-poll waiter. Thus idle views hold **zero** sockets; short periodic authenticated aggregate reads trade bounded request/JSON overhead for fairness across SSE, assets, checkpoint writes and other windows. The previous per-view bounded long-poll API remains compatible for callers, but the host browser no longer uses it. No HTTP server, CSP, session/Agent recreation, generation, CAS or checkpoint-action admission policy changes.

Freeze/restore, actual frame flush, positive/negative acknowledgement and committed old-generation close remain per capability. Reading an aggregate reply is never a flush acknowledgement. Closing an uncertain realm still cannot emit a clean status after its actual flush rejects. Tests explicitly enforce this negative case.

## Stable identity and exact lifecycle gate

Tool views already had inner call keys, but their owning conversation turns were keyed by provisional user/message IDs. `toolViewTurnKey` instead uses the first displayed tool-call identity when present. Atomic stream-to-history snapshots may change parent message IDs without destroying the iframe. The browser regression now verifies the **same actual iframe src/mount identity**, not just an equivalent thumbnail, after such a projection. Distinct calls stay distinct. The helper also emits production's `hosted_plugins_changed` event rather than a synthetic snapshot on catalog changes.

This does **not** invent continuity when a provider snapshot actually removes a call:

1. The existing streaming fixture subsequently invokes a real retained SDK prompt. That prompt first replaces the synthetic transcript with a snapshot lacking the old call; React removes its realm. The later actual result is a new mount. Its body/preview assertions pass, but teardown still rejects a busy/unknown old registration. Atomic-key preservation cannot bridge an actual absence in the authoritative transcript.
2. The competing-writer scenario intentionally reloads the losing dirty window. The original iframe/MessagePort is destroyed before it can return a successful flush. Re-handshake, retained losing local geometry, native draft download and **explicit** Restore succeed; they do not prove the old mount's latest draft was flushed or superseded safely. Shutdown still rejects its missing acknowledgement.

The current generic protocol has no content/draft identity, latest-local-draft checkpoint proof or authenticated handoff linking the destroyed old realm to a replacement. LocalStorage content, a newer server CAS revision, a clean replacement frame, the mount kind `tool`, elapsed time, or a closed socket is **not** proof that the old realm had no newer draft/in-flight write. Therefore there is no safe generic host-only retirement of those dirty/unknown registrations under this task's constraints. No TTL, registry clearing, synthetic clean status, fabricated ack, automatic draft restore or page reload was added.

Safe existing retirement remains: obtain a real flush/freeze acknowledgement while the original realm is alive, then close that identity-bound capability. To accept abrupt dirty reload / removed-call lifecycle, a follow-up must either preserve the original editing realm until acknowledged cleanup completes, or introduce a reviewed plugin-cooperating latest-draft/checkpoint handoff and explicit reconciliation UI. This task cannot substitute a generic "discard unknown views" option; plugin and recovery/storage changes are expressly out of scope. The exact failing gate and evidence are delivered rather than waived.

## Verification

- `npm run check`: PASS.
- `npm run build`: PASS (existing build warnings retained).
- `node --import ./test/setup-env.mjs --experimental-strip-types --test --test-concurrency=4 test/hosted-*.test.ts test/conversation-turns.test.ts`: **69 passed, 2 skipped, 0 failed**. New coverage includes aggregate bounds/auth isolation/write exclusion, 130-reader chunk fairness, single-flight cadence, reader removal, failure stop/no replay, stable turn keys and dirty/destroyed-realm negative acknowledgements.
- Full built-App Chromium run against the unchanged exact archive: **12 executed bodies: 10 passed, 2 failed**; the legacy-only diagnostic is skipped in this final run. Of the ten passing bodies, **two have `shutdown-failed-closed` annotations** (stream replacement and dirty reload). Thus only **eight are clean body + teardown passes**, not ten complete lifecycle passes.
- Clean passes include same-profile second editor, two same-profile windows with four actual SDK tool-result iframes each, composition/held native drag, labeled candidate review, both native source/SVG/transparent-PNG/theme sizes, and **both unchanged production lifecycle tests** (1440/390). Thumbnails are scrolled into view before requiring images, respecting their real IntersectionObserver lazy initialization.
- Remaining body failures: A06 viewport checkpoint lacks zoom; A09 unlabeled native shape materialization dereferences missing text. Plugin archive was not changed, nor were their assertions weakened. A06 no longer has a secondary shutdown failure in the final run.
- Existing independent-profile real CAS/local-rescue/download/reload/explicit-Restore assertions remain intact. They pass with the adverse teardown annotation above.
- `git diff --check`: PASS. `test/browser/hosted-production.spec.ts` is byte-unchanged from base.

Reproduction:

```sh
npm run check
npm run build
node --import ./test/setup-env.mjs --experimental-strip-types --test --test-concurrency=4 test/hosted-*.test.ts test/conversation-turns.test.ts
HOSTED_EXCALIDRAW_TGZ=/absolute/path/to/chengzhiyi-pi-excalidraw-0.1.0.tgz \
  npx playwright test test/browser/hosted-parity.spec.ts test/browser/hosted-production.spec.ts test/browser/hosted-transport.spec.ts --reporter=line,json
```

The final browser command is intentionally nonzero for the two unchanged plugin failures. The legacy diagnostic requires the **baseline-built** browser bundle plus `HOSTED_TRANSPORT_DIAGNOSE_LEGACY=1`; do not run its legacy-starvation assertions against the fixed aggregate bundle. No browser/OS/distributed-host/performance matrix certification is claimed.
