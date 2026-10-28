# ORI-54 follow-up: crash-safe ownership

Status: local validation complete; awaiting cross-platform PR checks and release.
Not yet published or applied to the user's storage.

## Why the first fix was insufficient

The previous stop receipt protects ordinary launcher shutdown: a rejected editor
flush must not close RPC input or claim a successful drain. It cannot protect a
host process killed independently of the launcher, or SIGKILL/power loss.

The old runtime and transaction mutexes used `open(path, "wx")` plus a JSON PID
record. Those files outlive their process. Refusing to steal an uncertain owner's
lock was correct, but every abnormal exit could permanently block the plugin,
then block the paired updater and consequently all management operations.

Observed local recurrence: the validated host (Pi PID 16260) exited on SIGTERM at
2026-10-27T23:36:36Z. Its runtime marker survived. Subsequent startup/paired update
reported `runtime_owned` then `host_pair_required`. The log does not establish who
sent the signal. This is not evidence of drawing corruption.

## Replacement mutex

Use Node's built-in `node:sqlite` (`DatabaseSync`, available in the existing Node
>=22.19 support range) to hold `BEGIN EXCLUSIVE` on a dedicated empty database for
each runtime/transaction lock. SQLite's OS byte-range locks release when the
connection or process closes, including SIGKILL. No PID probe, timeout lease,
heartbeat, pathname stealing, or extra npm/native addon is involved.

- `<name>.ownership.sqlite` is a stable inode. Never unlink, rename or replace it.
  It contains no plugin data or application transaction; no plugin snapshot is
  stored in SQLite. Never set journal mode to WAL or reuse these connections for
  other queries.
- `<name>.lock` contains the exact v2 compatibility marker. Old O_EXCL code cannot
  enter while it exists. New code first acquires kernel custody, then creates the
  marker exclusively, or reuses an existing **exact v2** marker under that custody.
- Normal release removes only its own marker **before** closing kernel custody,
  after all application work/drain has finished. Thus old hosts can still acquire
  storage after a clean stop. No abandoned pathname is deleted during acquisition.
- A legacy owner can win initial O_EXCL creation; the new host then refuses and
  releases kernel custody without touching the legacy record. Live v2 contenders
  fail/wait on the kernel lock, including contenders in the same process.
- Unknown, malformed, empty, legacy live-PID and legacy dead-PID markers all refuse
  online migration. Legacy offline recovery/verified backup remains required.
- Transactions yield between busy retries; synchronous SQLite waiting must not
  block the owner's JS event loop. A process-local custody set suppresses native
  lock attempts against a known local holder: Windows native lock retries can
  otherwise stall the releasing JS event loop even with SQLite busy timeout zero.
  This set grants no ownership; every acquisition still requires SQLite custody,
  and path aliases/independent processes are checked by SQLite. Local timeouts
  close only the waiting connection, never clear the holder's set entry.
  Contention timeouts never permit takeover.
- Activation, fork, workspace-file and pairing journals retain their existing
  validation and CAS semantics. Kernel mutex availability is not proof that an
  interrupted application transaction committed or that a journal may be deleted.
- The legacy offline recovery tool skips v2 markers and never touches SQLite lock
  inodes. A clean release removes v2 markers itself.

Use local filesystems only, with one stable storage namespace and working SQLite
locking. Network/shared filesystems with uncertain locking and external deletion
of ownership databases are not supported. Same-user malicious filesystem mutation
is not an isolation boundary. Power-loss durability and every filesystem/platform
remain separate certification concerns; no broad certification is claimed here.

## Compatibility and deployment

Host metadata now declares `piWebappHostedRuntime.ownershipProtocol: 2`.
New paired selection rejects candidate hosts lacking that support before writing
selection intent, rather than updating back into the known crash-deadlock design.
The outer hosted protocol remains 2 so existing hosts can stage the new package.

An existing legacy marker is **not** made safe by installing this code. Its first
repair still requires new scoped downtime permission, all owners externally
stopped, full verified storage/workspace backup, fingerprint-bound legacy lock
quarantine, and restart with one owner. Preserve pair journals and current state;
never roll back to an older snapshot to bypass this gate. The previous one-time
recovery permission is not reused for a second incident.

## Verification scope

- `test/hosted-ownership.test.ts`: real subprocess SIGTERM/SIGKILL for runtime and
  transaction custody; live independent-process and same-process exclusion;
  unchanged application state/journal bytes; legacy/partial/unknown lock refusal;
  event-loop-safe transaction contention; deterministic partial-marker race;
  symlink/hardlink rejection. `test/hosted-update-recovery.test.ts` verifies legacy
  offline recovery skips v2 fences.
- `test/hosted-launcher-stop.test.ts`: real Pi RPC, failed-flush stop refusal;
  abnormal Pi exit, cold start, activation of a staged newer package and actual
  uninstall; manually edited persistent drawing value/revision retained. The
  staged archive test does not claim real-registry update coverage.
- `test/hosted-pair-update.test.ts`: process exit during selection reconciles the
  same validated pair without offline lock deletion; downgrade capability gate.
- Existing paired HTTP updater, state/generation CAS, refusal and browser suites
  remain necessary. Native Linux/Windows and minimum-Node checks remain release
  gates, not claims inferred from macOS tests.

Local results (macOS): `check` and `build` passed. Integrity-pinned published
fixtures enabled: core Node suite **465 passed, 1 Windows-only skipped**; desktop
suite **94 passed**. The combined command hit the harness's 240s wall time after
core completed, so desktop was run separately to completion. Browser production
archive lifecycle at desktop/mobile sizes plus Chinese/English retained-lock
regressions: **4 passed**. Pure ownership suite on the actual bundled desktop
Node 22.23.3: **8 passed**. CI now requires Node 22.19.0 on Linux and includes the
pure custody tests in both macOS/Windows smoke checks before publishing.

Windows CI follow-up: the initial 30-way contention test still timed out after
its isolated budget was raised to 10s. Do not classify that as merely runner
slowness. The local retry suppression above removes redundant native attempts;
the strengthened test again uses the unchanged **2s production budget**, counts
exactly 30 native acquisitions, checks timed-out local waiters preserve independent
process exclusion, and settles all callers before cleanup. On macOS the preceding
implementation fails this new assertion (541 native attempts versus 30), while
the fix passes all 8 ownership tests and TypeScript checks. Native Windows CI
must still confirm the fix before release.

Old-source control: the real-RPC SIGKILL regression was run against the preceding
ORI-54 fix (`d21ac8b`) in an isolated source tree. Cold start produced `disabled`
instead of `active`, reproducing the underlying design failure.
