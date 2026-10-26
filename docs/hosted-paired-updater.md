# ORI-38 — controlled host / official-plugin paired updater

## Delivery boundary

Base: `4c0ebbd`, dedicated branch `feat/ori38-paired-update`, worktree `../pi-webapp-ori38`.
No publish, push, parent-worktree changes, release merge, native-signature changes, or client/plugin/protocol changes. Parent ORI-22 integrates the commit.

This is a production-wired transaction, not a preflight callback: bootstrap passes `manager.hostPair` into `SelfUpdater`; npm and capable desktop **business-package** updates run the same `select` and `restart` coordinator. The old `validateHostUpdate` API remains a conservative legacy check for callers/tests, not a claim of paired updating.

## Contract and ordering

1. Existing updater stages an isolated host using npm `--ignore-scripts` and retains existing version/data/desktop protocol, peer and PTY checks. Candidate host code is not imported/launched to discover hosted support.
2. The coordinator reads `package.json.piWebappHostedRuntime`: `protocol: 2` (hosted manifest API), `runtimeProtocol: 1`, `pairJournal: 1`, plus reviewed state/workspace/legacy/panels/messages capabilities. A worker path alone is insufficient. Package metadata, worker bytes and the staged application tree (excluding npm dependency trees) form the host digest; bounded reads, regular-file/tree budgets, no-follow files and worker realpath confinement reject escaped/mutated resources. Production startup also fingerprints the current application package root, not only its worker.
3. A private `host-pair/transaction.lock` serializes preparation and host selection across processes with manager startup, management/GC and policy mutations. Existing supervisor runtime-owner and broker state locks remain in force. Lock order is pair → policies/broker/installer; installer validation never runs candidate code.
4. Snapshot active generation/stateRef/operationId/enabled intent and policies. For official **installed** items only, retain a compatible highest local installation, otherwise fetch a stable compatible release with a floor of the highest installed version. Use the existing registry allowlist, SHA-512 SRI, archive extraction, manifest/capability, resource digest and immutable-version checks. Do not download absent items, change pins, enable disabled items, activate a future plugin on the running old host, or downgrade plugins. An incompatible pin or required download failure blocks host selection. A compatible local combination needs no network.
5. Write durable `intent.json` with selected plugin versions/digests and each prior active pointer; validate staged packages and recheck host digest/snapshot. Persist `selecting` **before** the actual npm/desktop host pointer writer, then `selected` after it. Successful selection records a digest of the actual host pointer. Failure before pointer selection preserves the old host pointer. Ambiguous pointer-write failures retain potentially selected host code and the journal instead of deleting a live release.
6. The journal reserves the combination after the short-lived disk lock is released. Management/policy writes refuse pending intent. Restart reacquires the lock and verifies host bytes, plugin bytes, active/policy fingerprint, host-pointer digest and requested launcher/version before writing `launcher.restart`.

Plugin installation can commit a new immutable archive to `installed.json` during staging. That is **not activation**: the current worker, active pointer, data and old compatible host remain unchanged. Such staged versions may remain after an aborted attempt.

## Startup and recovery

`HostedPluginManager.start` uses the same pair lock, **before loading any plugin worker**:

- Only the selected host version with the matching verified worker can consume a pending combination. It validates the retained candidate package and each selected plugin digest again.
- When active/policy fingerprints still match, enablement-preserving activation of the staged version runs through the existing supervisor/broker state-fork protocol.
- If a newer generation/policy/disable was accepted, startup does not replay the old selection. It loads only current compatible state, or reports required action. It never restores a journal's `before` state over a newer accepted pointer. A crash after plugin activation is therefore safely retried against the current active state.
- Disabled/absent plugins stay disabled/absent. Successful admission marks `reconciled`; integration records the host-version marker without immediately making a second registry-derived selection. Failure marks `required-action` with a message visible through hosted inventory. A wrong selected runtime cannot activate the staged selection. The old host can still admit its own compatible current runtime and expose the pending-pair diagnostic.
- A manually replaced native shell follows the same offline startup compatibility checks. Incompatible active code is not launched, and active/state data are retained. The visible action is to use a compatible host/plugin or explicitly change the pin. This is **not an atomic OS installer update**.

### Abandoned ownership is deliberately not auto-reclaimed

A hard exit while owning `transaction.lock` leaves an owner record. Startup fails closed with `storage_busy` and instructions to stop all writers; it does not infer safety from PID age/reuse. The tests actually exit a child process while selecting, prove that startup refuses takeover and journal bytes remain unchanged, then remove **only that lock** after observing child exit and stopping all other test owners. The next startup reconciles the selected pair.

Operator procedure: stop and verify all host/runtime/maintenance owners; back up hosted storage and host selection records; inspect `intent.json`, actual host selection and `transaction.lock`; only then remove a confirmed abandoned pair lock. Start the selected verified host to reconcile. For a changed/missing candidate or a newer incompatible active state, retain data and resolve the required-action diagnostic; do not copy `before` pointers over current plugin state or blindly delete journals. There is no automatic stale-lock reclamation or general-purpose journal-reset command in this delivery.

## Verification (local macOS / Node 24.21.0)

Commands from this worktree:

```sh
npm run check
npm run build
ORI38_EXCALIDRAW_TGZ=../pi-extensions-excalidraw-parity-fix/artifacts/ori-34/chengzhiyi-pi-excalidraw-0.1.0.tgz npm test
```

- TypeScript check and build passed; build reports existing Sentry default-export / chunk-size warnings.
- Full built-tree Node tests: **401 total, 397 pass, 0 fail, 4 skipped**.
- Desktop tests: **92 pass, 0 fail**.
- First full run before building failed because the fresh worktree lacked `dist/extension.js` and browser manifest/nonce assets. After the explicit build, all full-suite tests passed; this was not hidden as a code success.
- New pair tests cover npm + desktop selection/restart, required plugin upgrade, offline required-download failure, absent/disabled/pinned/no-downgrade, metadata rejection, fingerprint drift, actual pointer drift, candidate-byte drift, cross-process owner contention, before/after pointer exceptions, hard process exit with abandoned-lock recovery, repeated startup, and newer confirmed disable/state preservation.
- Real ORI-34 tgz verified SHA-256 `0036300e1647f0b79a2f565514645859639725ab0d167de005f32ca7988e9d97`; installed via the real installer and run via the bundled current-source worker. Six real tool descriptors were admitted across two **local synthetic host package shapes**, `0.1.29` and `0.2.0`; no claim that a public `0.2.0` host or successor plugin was downloaded. A synthetic incompatible `0.0.1` native replacement is refused with active data unchanged. Required-upgrade archives are explicitly synthetic fixtures with disjoint host ranges, not fabricated published releases.

## Actual remaining release gates / non-claims

- Preflight establishes a declarative/integrity-verified combination; it does not execute a future host or prove arbitrary future runtime health. Actual worker admission remains the startup supervisor health/schema/tool gate; failure there preserves state and requires action, not a claim of successful activation.
- No public registry host successor / paired plugin release was published or exercised; future releases must ship the explicit host contract. Older hosts lacking metadata are intentionally refused by controlled paired selection. Installer host-version handling remains stable-version-only; this does not add hosted alpha compatibility.
- Real native-shell/OS installer replacement, notarization, signing, Windows and Linux behavior were not tested here. Existing native release/signature guards are unchanged. No all-platform atomicity promise.
- Four inherited skips remain: live bootstrap notification test, two older external-archive tests gated by a different archive/env contract, and native Windows PTY. The new real ORI-34 archive test ran (not skipped); browser lifecycle/viewport coverage belongs to ORI-37 and is not claimed here.
- Desktop paired transaction tests stub npm downloads and desktop peer/probe execution; existing desktop-package tests separately exercise the real installed SDK/PTY verification. No unchecked future host worker/launcher was executed. Existing desktop compatibility probes and release guards were retained, not represented as candidate host integration execution.
- Disk owner/journal boundaries coordinate participating updated host managers. Unmodified old hosts, raw out-of-band filesystem edits and manual native installers cannot be made transactional by this code. Drift is refused or surfaced as required action; hard owner crashes require the stopped-owner procedure above. This is recoverable, fail-closed controlled selection, not an atomic commit across an OS installer and every historical host binary.
