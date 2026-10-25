# ORI-36 — host-linked official plugin synchronization

Bounded engineering result based on `aa86769`, branch
`feat/hosted-linked-update`. Parent ORI-22 owns integration. No push, publication,
release merge, provider calls, credential access, dependency installation or
sibling/shared worktree modification. `node_modules` remains an untracked,
read-only symlink and is not part of this handoff.

## Implemented behavior

- Actual `HostedPluginIntegration.start()` → manager host-version reconciliation
  now updates **already installed** compatible stable official plugins by default,
  including independent `notify` policy. The existing selection rejects
  prereleases, missing required capabilities, incompatible host ranges and
  downgrades. The pure decision helper distinguishes `independent` from default
  `host-linked` triggers.
- Independent explicit **Check updates** remains check-only. The management UI
  labels independent policy separately and explains host-linked behavior. There
  is no periodic independent update scheduler; the `automatic` preference is not
  a claim that one exists. Notify/automatic share the host-linked path.
- Absent plugins cause no registry or archive traffic. Disabled plugins can
  receive compatible installed code but never become enabled. Pins are retained
  and validated locally, never bypassed by the startup update. Diagnostics state
  that changing a pin is required to participate, or to fix incompatibility.
- Open editors keep the old active worker/generation and expose `pendingVersion`.
  Pending reconciliation no longer writes a success host-version marker. The
  explicit retry/undo-reset controls and generation/CAS protocol are unchanged.
- Offline/registry/archive/activation failures keep compatible local runtime and
  persist diagnostics; the host marker stays old/missing for next-process retry.
  Successful host versions check once, not every startup. Incompatible installed
  ranges or required capabilities fail closed during offline loading, before
  publishing runtime tools/assets. Enabled **intent** can remain true while the
  incompatible runtime is unavailable; it is not silently rewritten to disabled.
- `SelfUpdater.prepare()` now invokes a bootstrap-wired hosted pairing preflight
  before either npm launcher or desktop business-package selection is persisted.
  It validates the local latest, active (including disabled), pending and pinned
  plugin versions against the target stable host and required capabilities, and
  requires a hosted worker in the candidate package when plugins are installed.
  A known incompatible pair refuses selection with required action, leaving the
  current host pointer intact. Candidate failure cleans only its new staging
  directory. The ordinary updater failure/retry tests now inject pairing refusal
  and verify no update/restart pointer was written before a successful retry.

No AgentSession reconstruction, generic frame/view lifecycle or transport edits,
state/storage/recovery mutation semantics, download guards, native notification
changes, build/dependency/vendor/release guard edits. The actual
`hosted_plugins_changed` publication remains a catalog event, not page reload.

## Verification

Commands run in the exclusive worktree:

```sh
npm run check
npm run build
HOSTED_EXCALIDRAW_TGZ=/absolute/supplied/chengzhiyi-pi-excalidraw-0.1.0.tgz npm test
./node_modules/.bin/playwright test test/browser/hosted-update-policy.spec.ts
```

- Type checks: PASS. Build: PASS (existing chunk/source-map default-export warnings).
- Full Node suite: **381 passed, 1 Windows-only skip**; desktop suite: **92 passed**.
  Total **473 passed, 1 skipped**. No registry/provider requests by the added tests.
- Focused browser test: **1 passed**, real bundled management UI and authenticated
  bridge/manager, not a mocked catalog. Select pin, prove no linked download,
  return to notify, independent check without download, linked reconciliation
  downloads once and leaves plugin disabled. Policy remains notify in the UI.
- New manager/integration tests cover live default update, injected archive
  interruption preserving active generation, retry, no downgrade, absent/disabled,
  pin/future-host refusal, missing candidate worker, editor pending without undo
  reset, incompatible pinned runtime never publishing tools/assets, and persisted
  failed/successful startup markers.
- Exact external archive SHA256:
  `6eee13fe4dab6d68b20d17a0fe68741eba79dc085097149e609678b667c09f31`.
  Real `0.1.0` worker runs after stable host `0.1.29` → `0.1.30`, offline linked
  failure preserves runtime, subsequent startup retries, exact manifest metadata
  accepts the same compatible release, then unchanged host skips another check.
  There is no fabricated published successor: successor downloads in the other
  tests use explicitly local `integrationFixture("0.2.0")` archives only. The
  existing exact-archive import/edit/save/restart/disable/uninstall test also runs
  in the full suite.

## Remaining full paired-update release gates

This is **not** a fully atomic host/plugin/native OS updater or full A18 release
acceptance. The preflight is intentionally conservative: if a plugin needs a new
release/migration to work on a future host, it rejects selection rather than
pre-installing an unvalidated pair in the old running host. It does not execute
candidate host code or attest a future host's complete protocol/capability
implementation; candidate worker existence is only a coarse support check.

There is no cross-process lock covering the interval between preflight, host
pointer selection, restart, registry reconciliation and plugin activation. A
concurrent owner or later registry/network change can still prevent startup
synchronization; offline startup validation prevents incompatible local runtime
publication, but cannot make that interval atomic. Full staged pair manifests,
signed provenance, native macOS/Windows/Linux install integration, cross-schema
migration/rollback, power-loss/fsync and multi-process fencing remain parent
release gates. The native shell installer bypasses `SelfUpdater.prepare()` and
is **not** covered by this callback. No claim that it synchronizes plugins before
installing a native application update. Existing red parity viewport/multiwindow
browser cases are owned by other tasks and were not changed or rerun here.
