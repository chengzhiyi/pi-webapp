# Hosted plugin v2 runtime — implementation milestone

This is **infrastructure, not an enabled production feature**. Existing v1 plugins
and the built-in drawing integration are unchanged. Do not advertise full
hot-plugging until the installation/UI/session integration and acceptance matrix
are complete.

## Repositories and ownership

- Host branch: `feat/excalidraw-hosted-v2`, based on `d87f24e`.
- Public wire contracts: `@chengzhiyi/pi-web-protocol`, `src/hosted.ts` in the
  matching `pi-extensions` branch (initial contract commit `3e6bd11`).
- Editor, drawing domain and plugin-specific resources belong in
  `pi-extensions/packages/excalidraw`, not this runtime.

The host dev dependency is pinned to the checked-in, first-party protocol
snapshot `vendor/chengzhiyi-pi-web-protocol-0.2.0-dev.0.tgz`, compiled from protocol
commit `3e6bd11`. It has **not** been published to npm. This avoids a live sibling
symlink or a nonexistent registry version and makes the branch reproducible.
Before release, replace the development snapshot with the reviewed release
artifact/version and independently install the actual protocol/plugin packages.

## Implemented modules

`src/host/server/plugins/hosted/` contains:

- `resources.ts`: bounded, manifest-only prebuilt resources, hashes, MIME/size
  budgets, declared entries, no links or install hooks. Browser reads are
  digest-qualified and integrity-checked again. Backend entry is never served.
- `worker-entry.ts`: standalone ESM child-process entry, serializable runtime
  methods and invocation-scoped broker calls. Build it as a dedicated Node entry;
  do not make the host dynamically import plugin code.
- `runtime-process.ts`: allowlisted child environment, health/descriptor checks,
  IPC correlation, drain leases and teardown. Timeout is an unknown execution
  outcome: it retains the lease until execution ends and rejects later writes.
- `state-broker.ts` / `storage.ts`: scoped persistent CAS, version-state references,
  atomic active pointer and transition journal, workspace hash/no-replace commits
  and replayable file intents. Activation and **actual disk commits** share a
  cross-process disk lock; old generation checks are not merely UI filtering.
- `supervisor.ts`: prepare/health/drain/freeze/activate/dispose state machine,
  editor-safe pending updates, candidate failure retention and cross-host runtime
  ownership. `shutdown()` preserves enabled intent; `disable()` changes it.

The Node child and same-origin browser frames are lifecycle boundaries, **not
security sandboxes for malicious third-party packages**.

## Integration contract

The host supplies `HostedSwitchHooks`, authenticated workspace/session scope,
plugin policy and an absolute bundled worker entry. `canSwitch()` returns false
while an editor is open by default. `freeze()` must coordinate all affected
clients **and the safe Agent tool-batch boundary**; plugin-local idle alone is
not sufficient. Only the host's authenticated FlushBarrier may use
`flushAction()` while draining. Never expose that method as an unrestricted
browser/tool endpoint.

All normal requests use `supervisor.invoke()`. New invocations are rejected
while draining. Frames must flush, preserve IME/drag edits and acknowledge
freeze before the active record changes. At commit, reconnect frames and publish
updated tool descriptors through the long-lived host Adapter without replacing
AgentSession. A disconnected client must re-handshake; it cannot keep writing
with the old generation. Failures after commit do not roll back new user edits.

`HostedStateBroker.call()` accepts the public scoped broker methods:

- `state.read { key }` returns null or `{ revision, schema, value }`.
- `state.compareAndSwap { key, expectedRevision, schema, value }`: new records use
  expected revision 0 and return revision 1. Drawing-level revisions remain
  inside the opaque value.
- `workspace.read { path, maxBytes? }`: UTF-8 text/hash or null.
- `workspace.commit { path, text, expectedHash }`: relative `.excalidraw` paths,
  512 KiB maximum; null hash is atomic no-replace creation.
- `legacy.read {}`: a host-provided, read-only compatibility loader, not arbitrary
  filesystem access. The plugin validates and CAS-imports old checkpoints.

State and file-intent keys occupy disjoint hashed namespaces. Files retain the
same expected-hash/cooperative-lock semantics as the existing drawing save
implementation. This is not protection against a hostile OS user changing
parent directories or writing through unrelated non-cooperative processes.

## Verification

```sh
node --import ./test/setup-env.mjs --experimental-strip-types --test \
  test/hosted-plugins.test.ts \
  test/diagram-persistence.test.ts test/diagram-recovery.test.ts \
  test/web-plugins.test.ts
npm run check
```

Tests use actual Node child processes and temporary disk storage. They cover
resource rejection, independent-broker CAS, session isolation, on-disk stale
write rejection, atomic pointer recovery, candidate failure, pending editors,
flush failure retention, timeout leases, environment filtering, runtime ownership
and 50 enable/disable cycles with zero remaining old worker PIDs. They do **not**
certify full application behavior or browser/desktop integration.

## Explicit remaining work / limits

- Installer, npm identity/compatibility policy, archive extraction, install
  journal, immutable version registry and independent/host-linked updates.
- Official offline catalog card and management UI.
- Production authentication/routes, capability checks, SDK/TUI and retained
  session tool-policy adapters, safe batch boundaries and tombstones.
- Browser MessageChannel/FrameAdapter, controller/editor/tool rendering,
  beforeSend, all-window freeze and native interaction regression tests.
- Legacy checkpoint/ID aliases, verified schema migrations and lossless recovery.
  Cross-schema activation currently fails explicitly; it does not mutate data.
- Runtime/transaction locks are never auto-stolen by PID. Unclean exits require
  an explicit recovery path after stopping all owners. The lock-recovery UX and
  crash-stage tests remain release gates.
- State snapshots are not garbage-collected by this primitive; the integration
  must retain required rollback/active references and bound old snapshot growth.
  The 50-cycle test deliberately does not claim filesystem GC or heap SLOs.
- Electron packaging/child bootstrap and macOS/Windows/Linux, browser realm
  lifecycle, real provider concurrency and reference-machine performance.
- No built-in registration, drawing root dependency or fallback removal until
  external package parity and migrations are verified; never activate both
  implementations with the same tool names.
