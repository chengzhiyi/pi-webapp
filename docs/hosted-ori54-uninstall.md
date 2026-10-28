# Runtime ownership, unavailable editor and uninstall (ORI-54)

> Follow-up: this first fix covers orderly shutdown, not independent process
> termination. The recurrence and replacement kernel mutex are documented in
> [crash-safe ownership](hosted-crash-safe-ownership.md). Do not treat successful
> normal-stop verification as certification against abnormal host exits.

## Cause

The reported `runtime_owned` error is not an archive/uninstall error. The
supervisor cannot acquire `data/<plugin hash>/runtime.lock`, so startup cannot
publish editor assets or tools. Disable/uninstall correctly refuses the same
ownership conflict rather than deleting code used by another host.

The persisted `active.json.enabled` flag expresses enabled **intent**, not a
successful running worker. Previously management displayed only that flag and
the fallback editor suggested installation even for an already-installed plugin.

An additional reproduction uses the real bundled SDK RPC launcher: register a
dirty editor, request `stop`, and reject its freeze/save acknowledgement. RPC EOF
still exits after a failed extension shutdown handler, leaving the ownership
lock. Even extension-command prompt responses can report success after a command
handler throws; those responses cannot serve as a successful drain receipt.

## Fix

- Discover `web-prepare-stop` only from this launcher's exact extension path,
  including collision-qualified aliases. Before closing RPC stdin, request a
  drain while HTTP view/flush transport is still alive.
- The command emits an explicit `pi-webapp-stop` notification containing the
  unique request ID and boolean result. The launcher ignores stale/unrelated
  receipts and does not mistake an ordinary successful RPC prompt response for
  teardown completion.
- On failed save/release, retain the service, worker and lock; `stop` reports
  refusal instead of terminating Pi. Retry is explicit. A slow preflight never
  authorizes forced termination or concurrent teardown. The legacy EOF path
  remains for runtimes without the command, and the existing termination grace
  period begins only after a successful drain receipt.
- Enabled intent with a non-active phase is displayed as `Runtime unavailable`.
  Ownership errors explain that reinstalling does not clear the lock. The editor
  fallback directs users to runtime diagnostics, not just installation.

This does **not** steal an existing lock, infer abandonment from a PID, delete
journals, reset enabled intent, change generations during shutdown, reconstruct
historical model arguments, or delete drawings. Existing update pre-restart
shutdown remains idempotent with the launcher handshake.

## Existing retained locks

A new release cannot safely clear an older host's lock online. Use the existing
[offline recovery procedure](hosted-update-recovery.md#offline-operator-recovery--no-automatic-stealing): stop/fence every storage owner, verify a complete hosted
storage and relevant workspace-file backup, inspect exact bytes, then quarantine
only the fingerprint-bound ownership locks. Restart the selected compatible
host/plugin pair without deleting its journal. Verify editor availability and
state/file revisions before attempting uninstall.

## Regression coverage

- `test/hosted-launcher-stop.test.ts`: actual Pi RPC/extension/worker/HTTP; a
  rejected dirty-editor save refuses stop and retains lock/state; closing the
  view permits stop, releases ownership and preserves enabled intent; a cold
  restart publishes editor assets and uninstall succeeds.
- `test/browser/hosted-runtime-owned.spec.ts`: Chinese and English management
  against real HTTP/manager with a retained ownership lock; unavailable status,
  actionable diagnostic, failed uninstall, unchanged lock and active pointer.
- Existing live-owner exclusion, stopped-recovery, paired restart, launcher and
  history-recovery tests remain required.
