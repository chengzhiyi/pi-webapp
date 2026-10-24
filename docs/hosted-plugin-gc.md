# Hosted plugin reference-aware GC (ORI-29)

This implements disk retention, not cross-schema migration or final browser/desktop acceptance.

## Retention and fencing

`HostedPluginManager` collects after successful install/enable/update/retry and enabled offline startup. `collect(id)` is an explicit offline maintenance API, not a new HTTP route. The per-plugin manager queue fences preparation, pending selection and settled worker disposal. Collection takes the broker transaction lock, then the installer root lock; it never takes them in reverse order. External `installArchive()` calls therefore cannot race installation/index changes with removal.

Normal successive replacements leave **two installed versions and two state snapshots**: current and previous rollback. Additional references deliberately exceed that default:

- The current active record (including disabled intent) and durable `previous.json`.
- The supervisor's pending candidate, currently published package and in-flight asset reads.
- An explicit pinned version and the last accepted installation (including installed-but-disabled code).

The last accepted installation follows installation-index order, not semver order. GC does not change pin/disable policy or access the registry. The emergency installer cap of 16 remains an admission guard, not the steady-state collector.

Worker replacement returns only after old-worker disposal. Current/previous resources remain available during transitions. Asset calls register a version lease synchronously before their first filesystem await; GC samples those leases under the installation lock. Later requests use only the currently published package/capability. GC doesn't revoke capabilities itself.

State CAS, file commits, forking, pointer activation and snapshot collection share the same cross-process broker lock. A durable `fork.json` reserves a snapshot across the otherwise unlocked interval between fork and activate. A different activation target cannot clear that reservation. The transition journal retains `before` until the active pointer and rollback metadata are durable. Recovery updates rollback metadata only for a committed transition; it never copies an old snapshot over newer accepted edits. Same-state disable preserves the earlier distinct rollback snapshot.

## Crash and refusal behavior

Code GC writes `gc-journal.json` before atomically deregistering the complete removal set. Recovery either:

1. Sees every record still indexed and aborts deletion (index commit never happened); or
2. Sees none indexed and resumes idempotent filesystem deletion.

A mixed/unknown journal is refused, not guessed. Removal validates catalog identity and exact digest-qualified paths, checks real parent directories and never follows linked package trees. Failed deletion leaves a journal for retry. Uncommitted installation orphans remain inert for existing installation recovery/retry; this collector does **not** sweep arbitrary unindexed code directories.

Snapshot GC validates all directory names/types before deletion and checks that every active/rollback snapshot exists. Unreferenced snapshots must contain only recognized state envelopes or completed file intents. Unknown contents, links, unresolved file intents, and any transition/fork journal refuse destructive collection. A crash halfway through removing an unreferenced snapshot leaves an inert partial directory; the next collection safely repeats removal. Referenced snapshots are never renamed or removed.

Errors are surfaced through management failure/inventory (`gc_recovery_required`, or a specific storage error). **A GC error after replacement does not imply activation rollback**: inspect current inventory; accepted edits remain authoritative. GC may retain more than the normal budget when safe cleanup cannot be established.

Recovery is intentionally operator-controlled: stop all runtime/bridge/writer owners, preserve a copy of the storage tree, inspect the named journal and active/previous pointers, reconcile any uncertain workspace save against its expected/next hashes, then restore known-good metadata or resolve the reservation. Never delete locks/journals merely because a PID disappeared. No automatic destructive repair or schema migration is provided.

Uninstall skips collection entirely: it removes indexed code through crash-recoverable deregistration while retaining all state, rollback/transaction data, legacy source and workspace files. Explicit maintenance should not be used as an uninstall-data purge.

## Integration boundary and limits

The reference provider belongs to the one authoritative manager for a runtime. `installer.collect(id, references)` is a low-level primitive: arbitrary callers must supply all lifecycle references and hold the equivalent manager/broker fence. The installer lock alone cannot discover another manager's in-memory pending candidates. Do not run independent management authorities against the same storage tree; the runtime lock is not a distributed pending-package registry. External archive installation is supported under the shared installer lock, not independent external activation/GC authority.

Rollback references retain recovery inputs; no rollback endpoint or verified migration is invented. The parent integration owns HTTP/browser acceptance, platform/crash-process matrix and performance SLOs. Full filesystem scans/validation are conservative, not a heap/latency certification.

## Verification

`test/hosted-gc.test.ts` uses verified tar fixtures and real worker processes. It performs 50 different-version replacements with actual registry-shaped fixture downloads, CAS edits, GC and physical directory-count checks after every replacement. Both retained versions load offline; the latest accepted edits survive shutdown/offline restart. Other cases cover pending/pinned/disabled retention, uninstall preservation, cross-broker CAS fencing, fork reservations, unknown/partial journals, post-activation edits, interrupted cleanup, unsafe filesystem entries and concurrent external installation.

```sh
npm run check
node --import ./test/setup-env.mjs --experimental-strip-types --test test/hosted-*.test.ts
```

No force-exit, package publication, registry access, dependency install or release merge is required.
