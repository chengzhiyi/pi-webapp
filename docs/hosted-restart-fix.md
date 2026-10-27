# ORI-53 — drain hosted plugins before a managed update restart

## Failure chain

The update route previously set `restarting` before staging and rejected **all**
hosted POSTs. Later, launcher EOF initiated `session_shutdown`, which requires
registered views to poll, checkpoint and acknowledge a freeze. The updater's
HTTP fence prevented those requests. The view barrier permits 15 seconds, but
the launcher forces termination after 5 seconds. A killed host can leave
`runtime.lock`; the selected host then refuses plugin ownership and leaves the
pair journal in `required-action`, blocking the next update.

Startup reconciliation also attempted a second management update while that
pair was pending, replacing the original ownership error with the generic
`Host pair selection pending` diagnostic.

## Corrected ordering

1. The update route fences ordinary mutations and stages/selects the host/plugin
   pair using the existing integrity, snapshot and pointer checks.
2. Before requesting launcher EOF, `SelfUpdater.beforeRestart` calls the
   production hosted integration's shutdown **while authenticated HTTP and
   retained session scopes remain alive**.
3. During the fence, existing view capabilities may poll (including pollMany),
   report status, acknowledge and close. New mounts, discard and plugin management
   remain blocked. Actions receive a server-only `checkpointOnly` flag: only the
   already-reviewed checkpoint actions for the exact authenticated active freeze
   capability may execute. JSON cannot override this flag. Bearer, origin,
   workspace/session, generation and mount/token checks remain in place.
4. Agent settlement and view flush complete before workers exit and ownership is
   released. A failed flush writes **no restart marker**, returns an HTTP error
   instead of an early 202, restores admission and permits retrying the exact
   retained selection without downloading/selecting a second pair. Changing the
   requested target during that retry is refused.
5. After draining, the pair coordinator revalidates host/plugin bytes, active
   state/policy fingerprints and the host selection pointer, then writes the
   restart marker. Only then does the update route return 202. The subsequent
   `session_shutdown` reuses the completed shutdown promise rather than starting
   another view freeze. Shutdown does not disable persisted plugin intent or
   roll back active state.

Existing view CHANGE requests are validated against the coordinator's committed
identity, not the supervisor's transient `active` phase: status notifications
must remain possible during draining, while old-generation status after commit
must still fail.

## Diagnostics and existing abandoned locks

Startup preserves the actual error code (for example `runtime_owned`) and adds
its detail to the pending pair journal. Host-linked reconciliation skips a
pending pair instead of overwriting its startup diagnostic. Subsequent update
errors include the pending version, phase and recorded cause.

This is **not automatic stale-lock reclamation**. A missing PID alone is not
proof that all owners are stopped. Existing abandoned locks still require the
stopped-owner, verified-backup, exact-fingerprint recovery procedure in
[hosted-update-recovery.md](hosted-update-recovery.md). Do not delete the pair
journal, restore its `before` pointer, or bypass an integrity failure. This code
change does not mutate an already-running installed release or repair its disk
state in place.

## Verification

- `npm run check`: passed.
- `npm run build`: passed; inherited chunk-size and Sentry default-export warnings.
- `npm test`: Node **453 total, 448 passed, 5 skipped, 0 failed**; desktop
  **94 passed, 0 failed**. Optional external-archive/bootstrap and native-platform
  tests keep their existing environment/platform gates.
- New `test/hosted-restart.test.ts` exercises the real HTTP bridge, updater,
  pair coordinator, hosted manager and child worker with synthetic host packages
  (no npm download or synthetic launcher execution): successful restart ordering,
  negative flush and exact-selection retry, status transport during draining,
  mutation fencing, bearer/origin/forged-scope/capability rejection, ownership
  release, unchanged enabled/generation/stateRef at shutdown, idempotent shutdown,
  next-host reconciliation and preservation of an injected abandoned lock/error.
- Existing npm/desktop pair, SDK batch, view transport, supervisor ownership,
  launcher, update-safety and recovery suites passed in the full run.

No package publication, remote push, live-service restart, online 0.1.33 upgrade,
or existing user-data/lock recovery is included in this change.
