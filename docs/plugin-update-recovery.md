# Plugin lifecycle and host update recovery

## Scope and reproduced failures

This change is developed in an isolated checkout and temporary agent profiles. It
does not publish packages, change the user's selected installation, terminate
their backend, or read/write their drawings.

The regression tests first reproduced these independent failures on the original
source:

- A lost, busy headless controller rejects `freeze()` with “Close editors before
  updating” although there is no visible editor. Even a clean lost registration
  cannot answer a new flush command after its document is destroyed.
- The browser journal remembers registrations without a refresh handoff. A new
  document interprets every surviving registration as an unconfirmed editor,
  including non-authoring controllers.
- `SelfUpdater.prepare()` selects the host before `requestRestart()` drains the
  views. A refused drain leaves a `selected` pair, blocking unrelated plugin
  management and a different alpha target.
- A post-commit plugin publication exception leaves the process-wide Agent
  barrier frozen. Invalid optional plugin metadata can also abort base-host
  startup. Neither failure should own the lifetime of ordinary chat.
- The SDK adapter rejects every version except 1.3.0. This proves a version gate,
  not that another SDK implements the contract incorrectly.
- A native Node HTTP request and an explicitly proxied request can have different
  outcomes. That transport failure is independent of plugin lifecycle admission.
  Local proxy/server regressions test this without a user's API key or inference.

## Ownership and dependency direction

| Module | Owns | Does not own |
| --- | --- | --- |
| Desktop shell | Native window, installer/signature checks, launch capabilities, the "reset update state" escape route | Plugin state or drawing save acknowledgements |
| Launcher | Child process; the upgrade transaction: pointer selection, health admission, rollback | Browser drafts, SDK tool policy or plugin state |
| Host update coordinator | Check, download, validate, write the candidate, request a restart | The pointer, any cross-process lock, or plugin state |
| Plugin manager | Verified installed packages, one supervisor per plugin, per-plugin host compatibility | Whether the host updates, base chat lifetime or native installer |
| Plugin supervisor | Worker lifetime, generation and broker custody | Release-channel preference |
| View coordinator | Exact view capabilities, authoring barriers, recovery quarantine | Claiming a lost document saved its draft |
| SDK adapter | Capability qualification, dynamic tool registration and permissions | Declaring compatibility from a version string |
| Model transport | Proxy-aware requests and redacted transport diagnostics | Plugin activation, host selection or editor state |

The composition root wires these interfaces. Plugin packages continue to depend
on the public plugin protocol, declared capabilities, resources and data schemas.
Host ranges remain compatibility constraints, not a requirement to install one
plugin release per host patch. Release dependencies remain lockfile-pinned.

## View lifecycle

Controllers are a reviewed non-authoring role. They do not hold an editor's local
draft or undo stack. A controller's active server actions must drain, but its lost
document cannot indefinitely prevent a plugin switch. An editor, workspace or
tool view may hold local authoring state and remains conservative.

The recovery interface distinguishes:

- **Acknowledged close**: the exact live view checkpointed and closed normally.
- **Controller retirement**: no authoring data and no in-flight action; this is
  not a manufactured save ACK.
- **Unconfirmed authoring view**: local edits are unknown; keep the record and
  offer recovery copies and inspection.
- **Explicit retained recovery**: revoke the old capability and quarantine its
  recovery record so the plugin can operate again. This neither saves/discards
  the old draft nor applies an old scene over the winning drawing.
- **Explicit discard**: a separate per-view user decision. Never infer it from a
  timeout, page reload, a newer drawing, or a missing process.

Initialization cancellation is allowed only before an acknowledged initialized
state or action. Scope and capability checks apply to reconcile, recover and
discard just as they do to ordinary writes. Browser backup bytes stay local;
recovery export does not mutate a drawing.

## Restart lease and failure containment

The browser's upgrade observer belongs to the stable `PiApp` update provider.
Settings and the sidebar consume the same controller, installation lock and
readiness observation. Navigating to Models, closing Settings, or automatic
model setup after a reconnect does not destroy the pending upgrade observation.
This was reproduced with the built application and real launcher: the backend
had restarted into alpha while the old Settings-owned observer had unmounted.

The host obtains a reversible restart lease before it requests a restart. All
genuine authoring view checkpoints finish while authenticated HTTP is still
available. The lease suspends workers without changing their active pointers,
data schemas, generations or asset identities. If the restart request cannot be
written, undo recreates the verified old worker at the same generation and resumes
the same live views. Real process exit consumes the lease instead of freezing twice.
A view that never confirms its save asks the user once; a confirmed retry proceeds.

The transaction after that point belongs to the launcher; see the upgrade contract
below.

Plugin publication recovery is scoped by plugin ID. Its writes and tools remain
denied until recovery, while base-chat admission is released. Freeze failures and
settlement timeouts release admission too. Recovery never rolls a committed data
generation back or unregisters permissions to make a test pass.

## Upgrade contract (0.1.51 and later)

**Layering.** Desktop shell → launcher → host → plugins, from most to least stable.
Upgrade decisions flow only from a more stable layer to a less stable one. Plugins
never take part in deciding whether, or to which version, the host upgrades. The
version being upgraded never judges its successor beyond checking the downloaded
package is the requested, complete release.

**Host** (`SelfUpdater`): check, download into `pi-web/releases/<version>-*`,
validate, prefetch plugin releases compatible with the target (best effort), write
`pi-web/upgrade/candidate.json`, and after the reversible drain write
`launcher.restart` as `{ nonce, candidate }`. It writes no pointer, no host-pair
journal and takes no cross-process lock. `update-transaction.json` is host-local
history (downloading → validating → prepared → restart-requested → committed or
failed) whose failure messages carry the real cause. A record this process does not
own, from an earlier run or an earlier version, is settled as history the next time
the host checks; it never fences an update.

**Launcher** (`bin/upgrade-transaction.mjs`, run by `bin/pi-webapp.mjs`): on a
candidate restart it writes the pointer (`update.json` or `desktop-update.json`)
with the running version as its single rollback entry, records `selected` in
`pi-web/upgrade/transaction.json`, starts the candidate's launcher, and admits the
new version when that launcher reports ready. Otherwise it restores the exact
previous pointer bytes (only while the pointer is still the one it wrote, never over
another client's change), records `rolled-back` with the cause, and restarts the
previous version. Outcomes go to `pi-web/upgrade/history/`. The host reports the last
failure in Settings.

**Health admission excludes plugins.** Session start waits at most 10 seconds for
plugin startup and then continues; a slow or hung plugin keeps starting in the
background and reports on its own card.

**Plugins are checked per plugin** against the host range each release declares.
At startup the active version is used when it supports the running host, otherwise
the newest installed version that does; failing both, the plugin is unavailable
with its data retained. Before an update, Settings lists plugins that would be
unavailable (`pluginWarnings`); the list never blocks. Plugin install, enable,
disable, update and uninstall queue per plugin and use only that plugin's storage
locks; no host-update record fences them.

**All persisted upgrade state fails open.** Every record carries `schema: 1`. An
unreadable, unknown-schema or invalid record is renamed aside (bytes kept) and read
as absent; a candidate older than 24 hours is treated as expired. A restart marker
from another launcher nonce is moved to `restart-history/` instead of blocking the
exclusive write. Kernel-custody storage locks are released by the OS on process
exit and never reclaimed by PID guesses.

**Compatibility with older hosts.** Hosts up to 0.1.50 stop updating whenever
`hosted/host-pair/intent.json` holds a raw `required-action` or an in-flight phase,
and they refuse candidates whose `package.json` lacks `piWebappHostedRuntime`
(protocol 2, runtimeProtocol 1, pairJournal 1, ownershipProtocol 2 and the five
capabilities). This package keeps that metadata (a test pins it). New hosts never
start a switch in the pair journal; at startup they settle any record an older host
left (reconciled when its selected host runs, cancelled otherwise) and re-encode a
settled `required-action` as `reconciled` + `lifecyclePhase` so an older fallback
host can update past it.

**Escape routes, from most stable down.**

1. Desktop shell menu *Reset Update State and Use Bundled Version…*: stops the
   backend this shell started (with an explicit force when a plugin view never
   confirms its save), moves every upgrade record into
   `pi-web/upgrade-reset/<time>/` with a receipt, and starts the bundled version.
   It never stops a backend it does not own and deletes nothing.
2. Offline CLI `settle-pair` (`dist/hosted-recovery.js`) for an install already
   stuck on an older host without a capable shell; see
   [hosted update recovery](hosted-update-recovery.md).

## Verification interpretation

Tests using a local npm catalog or deterministic model stream exercise the real
installer, resource validation, HTTP bridge, broker, worker process and retained
SDK object. They do **not** certify public network availability or live model
inference. Browser tests use the built application and published plugin fixture;
the fixture transport is controlled and clearly distinct from public delivery.

See the final verification report alongside this document for exact executed
commands, pass/fail/skip counts and limits. Native signed desktop installation,
physical power-loss recovery and every OS/browser remain separate acceptance
claims; no local unit-test total substitutes for them.

## View ownership and previous-document recovery

A reviewed `controller` mount has no local authoring surface. Its mutations run
through authenticated host actions and count toward `activeActions`; an in-flight
action prevents retirement or switching. Controller readiness/status does not
create an editor-save obligation. Controllers receive committed-generation
notifications and reconnect normally, but are excluded from authoring flush ACKs.
A future controller that holds user-editable state must use an authoring mount or
introduce a reviewed data-risk contract first.

Editor, workspace and tool mounts keep their real flush/ACK obligations, including
hidden authoring frames. No heartbeat, age or newer drawing proves an old edit was
saved. A client persists a randomly generated registration capability **before**
its register HTTP request. Registration is idempotent for that exact identity;
reconciliation fences a late abandoned registration, closing the reload race
between server registration and response delivery. A never-started registration
can be cancelled only while the server has observed neither status nor an action.
The editor connecting marker must be stored before an authoring document starts;
if that write fails, base chat stays usable but that editor does not open.

On reload, the parent reconciles exact prior capabilities with the authenticated
owner/workspace/session scope. Headless controllers can retire after actions
drain. An authoring view remains unconfirmed. The user can inspect it, download
existing local backups, reopen the drawing to compare backups, or explicitly
retain the disconnected capability for recovery. Retention revokes further writes
from that capability and removes it from active lifecycle barriers. It retains
metadata and available backup bytes; it is **not** a successful save or a discard.
Unknown authoring capabilities after a real host restart remain recoverable in the
browser journal. Explicit discard is a separate, individually confirmed action.

For the official drawing plugin, the host snapshots existing `pi-diagram` local
backups to per-view recovery keys before React mounts replacement editors. This
prevents a new editor's adoption of the winning server drawing from replacing the
only old local backup. Exports are exact local recovery copies, never automatic
restores or proof that the copy contains every lost edit. Recovery copies remain
local; no new data is sent to a registry or model. Malformed journal bytes are
preserved and do not crash ordinary chat.

The browser regressions use the actual published drawing archive, real native
canvas edits, built App, authenticated HTTP, worker and retained SDK session. One
case rapidly reloads a controller-only document twice, then updates, disables,
enables and uninstalls. Another injects a checkpoint HTTP503, makes a genuine
unsynced canvas edit, reloads, exports its exact old geometry and explicitly
retains the old capability before updating/uninstalling. The winning server
scene is asserted unchanged. HTTP503 is fault injection, not a claim of real
Internet/provider failure or certification of arbitrary interrupted transports.
