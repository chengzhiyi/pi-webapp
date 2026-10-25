# Hosted Excalidraw alpha integration

This integrates the previously accepted optional official Excalidraw plugin runtime
with alpha's conversation activity feedback. The official editor is independently
published as `@chengzhiyi/pi-excalidraw@0.1.1`; it is not a host dependency.

## Distribution gates

- Host development now pins the published `@chengzhiyi/pi-web-protocol@0.1.1`
  with registry SHA-512 lock integrity. The former development-only vendor tgz is
  removed. Release CI verifies the exact protocol pin instead of following a
  later registry `latest`. A mismatched registry version fails closed.
- CI fetches only exact published plugin test fixtures via `npm pack
  --ignore-scripts`, independently verifies their recorded SHA-512/SHA-256, and
  enables the previously opt-in archive, paired-update, v1 compatibility, stress
  and public npm tests. These are test fixtures, not bundled host dependencies.
- A separate strict hosted browser gate rejects missing production lifecycle
  cases, silent fixture skips, retries, and failed-closed shutdown annotations.
  Only the explicitly obsolete socket-pool diagnostic is allowed to skip.
- Alpha publication remains the normal verified-source CI path, uses npm's
  `alpha` tag, and never updates stable `latest`. Version allocation uses actual
  registry tags at release time; there is no speculative version-only commit.
- No desktop installer publication, stable release, gate bypass, or unsupported
  platform certification is implied by this alpha change.

## Integrated behavior

`PiConversation` retains activity/status elapsed feedback as well as the hosted
transcript retirement boundary and tool-view incarnation keys. Activity tests
supply an explicit empty hosted inventory: an activity-only fake host must not
produce an unrelated missing-integration 503 alert. Error assertions remain
strict. Public npm test failure receipts include the management response and
inventory diagnostics; network failures are not silently substituted with local
archives or retried by the test.

## Local pre-PR evidence

- `check`, `build`: PASS with published protocol 0.1.1.
- Node: 429 PASS / 1 Windows-only SKIP; desktop Node: 94 PASS.
- Hosted Chromium: 32 clean body-and-shutdown PASS / 1 historical diagnostic
  SKIP, strict gate 0 (including 70-cycle lifecycle stress).
- Activity 1440/390/320: 3 PASS.
- Real public npm installation 1440/390: 2 PASS; real 0.1.0 → 0.1.1 update
  1440/390: 2 PASS. Same SDK session and parent page, data retained. Model
  outputs are deterministic fixtures, not live provider inference.

Earlier local failures remain evidence: missing postinstall PTY executable-bit
repair after an ignore-scripts dependency install, an old fixture SHA parameter,
activity fake-host 503 alerts, and intermittent public download/500 failures.
A full browser run was cancelled at the harness's 15-minute limit without a JSON
report and is NOT claimed as complete. Bounded suites above were subsequently
run explicitly; the full repository suite must still pass in PR CI before merge.

Previously approved unavailable GUI/platform/IME skips remain SKIP, not PASS.
A successful PR workflow is verification only; host publication and registry
source/integrity receipts are separate required outcomes.
