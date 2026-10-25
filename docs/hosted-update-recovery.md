# Official plugin update policy and stopped-owner recovery (ORI-33)

Bounded implementation on `feat/hosted-update-recovery`. No publication, push,
release merge, dependency installation or shared-alpha changes. This is not full
A01–A25 release acceptance. See [runtime](hosted-plugin-runtime.md),
[installation](hosted-plugin-installation.md), [GC](hosted-plugin-gc.md) and the
[historical production matrix](hosted-production-acceptance.md).

## Software-linked updates (supersedes ORI-33 policy UI in ORI-42)

Installed official plugins follow software updates without a strategy setting.
Legacy `notify`, `automatic`, and `pinned` records are validated and normalized to
`notify` (manual independent checks; fixed software-linked updates). Startup
persists that migration under the policy lock. Old pins no longer block install,
manual update, pending retry or controlled host/plugin combination selection.
The legacy policy endpoint remains parser-compatible but cannot reinstate a pin.

Absent plugins are not installed; disabled plugins remain disabled. Compatible
higher versions are not downgraded. Open editors defer activation; after closing
editors, use Apply pending update, or explicitly accept the reopen/undo reset
confirmation. No page reload, fake close acknowledgement or TTL is used.

Independent check never downloads a tarball. Manual update remains available.
The paired business-package updater checks for newer compatible official code
as well as required upgrades. Offline/download failure retains compatible local
code; incompatible combinations fail before host selection. Native OS updater
coverage is not expanded by this change.

Checks and structured failure codes persist in `policies/update-checks.json`.
An equal release is not an available upgrade. `host-version.json` is written only
when synchronization succeeds. A controlled pair admitted using offline fallback
does not mark synchronization complete: the next startup retries. No background
interval or repeated mutation retry runs. Diagnostics are collapsed in the UI;
metadata 404, missing tarball, no compatible release and network failure remain
distinct. See [ORI-42 evidence and reproduction](hosted-ori42-management.md).

## Offline operator recovery — no automatic stealing

`runtime.lock` and `transaction.lock` are never removed by startup, PID inference,
heartbeat timeout, UI or an HTTP endpoint. The utility below is **offline only**.
Its confirmation is an operator attestation, not an OS-enforced proof of dead
ownership. Filesystem rename is NOT an online compare-and-swap primitive.

Before invoking a mutation, the operator MUST:

1. Stop **all** host/bridge services and plugin child processes using this storage,
   including other desktop windows, terminals and machines sharing it. Disable
   service restart/watchdogs and retain exclusive filesystem custody. A missing
   PID (or reused PID) is insufficient evidence. Record the actual service-stop /
   process-tree evidence externally; do not merely close the browser.
2. Back up the complete hosted storage tree **and relevant workspace files** to a
   separate location and verify the copy. Never use an old snapshot as the active
   pointer when newer generation writes might have been accepted.
3. Inspect exact paths and byte hashes with the tool. Review active/previous,
   transition, fork and lock metadata against that backup. It lists hashes, not
   arbitrary file contents; inspect the named local JSON records with local tools.
4. Keep owners stopped throughout inspection, confirmation and repair. If external
   isolation cannot be established, **do not run recovery**. Escalate rather than
   trying to detect dead ownership from a PID.

The build ships `dist/hosted-recovery.js`. From source, substitute
`node --experimental-strip-types scripts/hosted-stopped-recovery.ts` for
`node dist/hosted-recovery.js`. It is a local CLI, not a new network/filesystem API.
Use a trusted installed/source checkout. `DATA_ROOT` is `<hosted root>/data` and
`BROKER_ROOT` is `DATA_ROOT/sha256(pluginId)` (the report root for that plugin).

```sh
CONFIRMATION=ALL_HOSTS_AND_PLUGIN_WORKERS_STOPPED_AND_BACKUP_VERIFIED
node dist/hosted-recovery.js inspect "$BROKER_ROOT"
# Review report; manually copy its exact fingerprint only AFTER the checks above.
node dist/hosted-recovery.js recover-locks "$BROKER_ROOT" "$FINGERPRINT" "$CONFIRMATION"
```

Every input file is included in the fingerprint. Changed bytes, unsafe links,
oversized/non-regular files, missing consent or old fingerprints refuse recovery.
Only root `runtime.lock` / `transaction.lock` are renamed to fingerprint-qualified
`recovered-*.json` audit records; an audit receipt is written. No active pointer,
state snapshot, journal or workspace bytes are removed by this operation. A crash
mid-recovery is inspectable and needs a fresh report. Never reuse a fingerprint.
The same lock operation can inspect/recover a known installer/policy root's
transaction lock, but it does not repair their unknown/corrupt journals.

### Activation transition / abandoned fork

After lock quarantine, refresh the report and fingerprint. A known activation
journal can be reconciled offline, using the **data parent** and exact plugin ID:

```sh
node dist/hosted-recovery.js inspect "$BROKER_ROOT"
node dist/hosted-recovery.js reconcile-transition "$DATA_ROOT" \
  '@chengzhiyi/pi-excalidraw' "$FINGERPRINT" "$CONFIRMATION"
```

The broker accepts only a journal whose complete before/next pointer matches the
actual active pointer. A committed transition completes previous-snapshot metadata;
an uncommitted transition never replaces the active pointer. Unknown/corrupt or
unrelated pointer/journal combinations preserve evidence and refuse recovery.

A crash before activation can leave `fork.json`. Startup deliberately will not
guess it away. Once transition reconciliation has completed, inspect **again**:

```sh
node dist/hosted-recovery.js inspect "$BROKER_ROOT"
node dist/hosted-recovery.js recover-fork "$DATA_ROOT" \
  '@chengzhiyi/pi-excalidraw' "$FINGERPRINT" "$CONFIRMATION"
```

Only a recognized, inactive fork not referenced by active/previous and with no
transition can be quarantined. Its snapshot bytes remain. Normal reference-aware
GC later validates any unreferenced snapshot before removal. A referenced or
unknown fork is refused even with confirmation. If recovery rejects anything,
keep the backup, stop and inspect; never bulk-delete journals/locks. Workspace
`*.excalidraw.lock` files and uncertain file intents are intentionally **not**
handled by this tool: reconcile the actual workspace save against expected/next
hashes with the operator before a separate scoped repair. No arbitrary file-lock
or file-write endpoint has been added.

Restart one owner only after recovery. Confirm inventory, enabled intent, active
version/generation and latest drawing revisions; compare workspace hashes to the
verified backup. The UI explains the offline recovery path for lock errors.

## Fault matrix and reproducible evidence

New `test/hosted-update-recovery.test.ts` runs 14 cases. SIGKILL cases use real
subprocesses and real on-disk locks. Injection is a constructor callback supplied
only by the test fixture; there is no environment-variable or HTTP kill switch.

| Fault / gate | Verified result | Remaining limit |
| --- | --- | --- |
| A12 network interrupted during archive | Existing immutable package digest unchanged; persisted failure | OS disk-full/fsync/device-failure and every download cancellation timing NOT exhaustively injected |
| A12 malformed archive/integrity/cancel | Existing installer negative tests pass | Not a packaged updater fault suite |
| health: candidate child SIGKILL | Old PID, active pointer, state and saved file hash unchanged; old runtime callable | Arbitrary native/plugin hangs not exhaustively covered |
| forked: host killed after snapshot copy | Old active pointer/write set survives; orphan reservation blocks GC until explicit fingerprinted recovery; retry works | Requires external offline fencing |
| prepared: killed after transition journal | Before pointer authoritative; same controlled fork recovery and retry | No automatic lock stealing |
| committed: killed after active rename, before cleanup | Next pointer authoritative; old-generation writes rejected; recovery then new writes remain after repeat recovery | Power loss/directory fsync behavior per OS NOT certified |
| cleaned: killed after metadata cleanup | Next pointer only; workspace hash unchanged; new writes retained | Same platform caveat |
| unknown journal vs active | Refuse without deleting journal or replacing pointer | Manual forensic restoration required |
| active/previous referenced fork | Refuse even with confirmation | Never resolves ambiguity by rollback |
| A15 schema differs after latest accepted writes | Explicit migration-required rejection; latest state/pointer preserved | No cross-schema migration or rollback implementation |
| A17 independent check / linked default / automatic / pinned / absent / disabled | Actual manager transport counters, persisted diagnostics, no newer release and no-compatible explanations | New UI compiles/builds; no new browser policy-control interaction run |
| A18 failed vs successful startup | Failure retries on next startup; success checks once per host version | Full paired application/plugin updater remains out of scope |

Validation on this worktree:

- `npm run check`: PASS.
- `npm run build`: PASS; existing chunk-size / source-map proxy default-export
  warnings (including the new CLI entry), not runtime/test failures.
- Full `npm test` with exact external archive: Node **374 passed, 1 Windows-only
  skipped**; desktop Node **90 passed**. **464 passed, 1 skipped** in total.
- All focused hosted tests: **60 passed, zero skipped** (includes exact archive).
- Bundled CLI invalid-argument usage exits 2, without modifying storage.
- Exact external archive SHA256:
  `6eee13fe4dab6d68b20d17a0fe68741eba79dc085097149e609678b667c09f31`.

```sh
npm run check
npm run build
HOSTED_EXCALIDRAW_TGZ=/absolute/path/to/chengzhiyi-pi-excalidraw-0.1.0.tgz npm test
HOSTED_EXCALIDRAW_TGZ=/absolute/path/to/chengzhiyi-pi-excalidraw-0.1.0.tgz \
  node --import ./test/setup-env.mjs --experimental-strip-types --test \
  --test-concurrency=4 test/hosted-*.test.ts
```

The counts above are the historical ORI-33 milestone; see the ORI-36 report for current validation.

The strict CSP, third-party font/code prohibition, generation/CAS broker,
parent/session identity and native undo lifecycle are unchanged. No generic
frontend frame-lifecycle files or browser tests changed. Real packaged
macOS/Windows/Linux recovery, power-loss/fsync, disk-full, signed provenance,
cross-schema migration and coordinated desktop host/plugin upgrades remain
explicit release gates, not claims of this patch.
