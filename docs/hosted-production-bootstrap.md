# Hosted production bootstrap (ORI-28)

## Optional official plugin, default hosted ownership

Start a **new host process** after migrating from a builtin-era host. Hosted is
now the only drawing owner; no flag is required. `PI_WEBAPP_HOSTED_EXCALIDRAW` is
retired (even `0` cannot bring the builtin back). The official package is absent
until explicitly installed; offline startup restores enabled installed intent only.
Files, terminal, git and v1 plugins (including plan mode) remain. The adapter rejects
conflicting tools without overwriting owners, reloading or replacing sessions.
Reloading an older builtin host into this ownership mode is explicitly refused.

The root editor dependency, exclusive overrides, builtin drawing client/server,
font/chunk build hook and notices are removed. Only tiny metadata/icon/history
recovery remain. See [migration and package verification](hosted-excalidraw-migration.md).
This is not authorization for publication, push, release merge or credentials.

## Composition and authenticated boundaries

`pi-host.ts` owns one `HostedPluginIntegration`, created lazily without opening
resources in the extension factory. TUI `session_start` mounts the same adapter and
starts offline runtime restoration. Every SDK `WorkspaceSessions` construction
receives that adapter's inline factory; retained/background sessions stay attached
until real shutdown. Hosted actions never reload or replace any AgentSession.

`BridgeHost.hosted` connects inventory/manage/action/views/assets to the actual
manager and coordinators. Existing bridge authentication, origin and bounded-JSON
checks remain authoritative. Scope is resolved on every call from the current TUI
or an actual retained non-closing SDK runtime; saved session IDs alone do not grant
access. `cwd`, workspace and owner fields in browser bodies are ignored. Workspace
identity is a hash of the canonical host cwd. Owner identity is the stable local
OS/agent-directory principal behind the bridge bearer token, not a browser ID.
This bridge is a single-local-principal host, not multi-user tenancy.

The catalog returns full `HostedPluginCatalog` DTOs after acknowledged management,
including pending versions and manager errors. Document/controller paths come from
the verified installed manifest (both `./dist/...` and `dist/...` normalize), joined
to the manager's generation-rotating capability/digest asset base. Only reviewed
static Excalidraw frontend contribution data from package commit `6328c63` is
supplied. Frontend `describe` is never an authorization source and no plugin code
is imported into the host realm. Candidate tools must match the six reviewed
name/action pairs and readonly policy; schema/description data stays data-only.
Tool execution results are converted to SDK `{content, details}` by the host.

Normal UI actions use a host-owned reviewed action allowlist and manager.invoke,
with current generation and exact retained scope. UI actions are not model tool
policy calls. Model tools separately enforce enabled/allowlist/plan/nested/exposure
policy through HostedAgentAdapter; nested calls are denied by default. Existing v1
plan-mode extension hooks remain authoritative and can conservatively deny these
tools; this integration does not synthesize execution grants from persisted plans.

## Switching order and recovery

All host management, startup reconciliation and shutdown share one global queue.
The outer `adapter.freeze()` closes new batch admission **before** manager/supervisor
drain. Already-admitted batches keep using the still-active old worker through
`agent_settled`, including automatic followups. Management is exposed only via host
HTTP, never a model tool/extension command that waits for its own settlement.

Supervisor hooks require the outer gate, freeze every registered frame, preflight
candidate ownership/official readonly policy before persistent activation, publish
the new retained-session descriptors, commit view generation, then thaw admission.
The prerequisite parent seam is `validateCandidate` (original `1c7d901`, locally
cherry-picked as `f6e425c`; parent subsequently rebased its equivalent commit).
The manager lifecycle option is intentionally not nested inside the outer queue.

Default enable/update waits for editor closure and exposes `pendingVersion`.
`reopenEditors: true` is the UI's explicit undo-reset warning branch; that setting
is scoped to one queued operation and cleared on every exit. Retry is explicit.
While gated, only `sync` and reviewed prerequisite `get`/`list` can enter
manager.flush, and only with an exact owner/workspace/session/mount/generation view
capability in the coordinator's **currently pending freeze barrier**. A normal
request, guessed action name, old capability or reopen flag cannot use this route.
Every view operation resolves retained authorization anew; old committed identities
may only poll/ack/close their bound handshake, not register/change or execute edits.

Publication failure after broker commit is sticky: catalog reports recovery,
management reports failure, and normal admission remains frozen. The new active
pointer/data is never silently rolled back. A dedicated operator recovery UX is
still required; do not automatically steal abandoned runtime locks. Missing/dirty
views never expire by TTL. Ordinary precommit failure resumes old views/tools.

## Startup and shutdown

Before manager.start, coordinators initialize from each broker's persisted active
generation. Offline start loads only previously enabled installed packages; an
absent official card does not trigger registry access. Restart advances generation
and requires fresh authenticated registration, so old clients cannot edit without
re-handshake. Host-version reconciliation is recorded atomically in
`host-version.json` once per host version. It only considers installed plugins,
preserves disabled intent and pin choices, and leaves compatible installed code on
registry failure. Failed offline reconciliation is not automatically retried every
startup; explicit management/check is available.

Quit drains all retained Agent batches and frame barriers before worker shutdown;
enabled installed intent remains persisted. Dirty/disconnected frames can refuse
shutdown; this must not be reported as a successful checkpoint or fixed by deleting
locks. Process crash, distributed views, automatic lock recovery and recovery UX
are not certified here.

## Verification

```
npm run check
node --import ./test/setup-env.mjs --experimental-strip-types --test \
  test/hosted-bootstrap.test.ts test/hosted-integration*.test.ts \
  test/hosted-agent*.test.ts test/hosted-views.test.ts test/hosted-routes.test.ts \
  test/hosted-installation.test.ts test/hosted-plugins.test.ts \
  test/background-sessions.test.ts test/drawing-*.test.ts test/legacy-checkpoints.test.ts \
  test/prompt-queue-bridge.test.ts test/web-plugins.test.ts
npm run build
```

Historical bootstrap milestone: 42 tests passed, with actual SDK, Node worker, manager and authenticated HTTP fixtures,
without provider networking. Coverage includes actual pi-host opt-in lifecycle,
old-schema batches finishing before drain, concurrent management serialization,
retained/new same-object session tools, install/enable/update/retry/disable/uninstall
without reload, no builtin drawing UI/catalog/routes in opt-in mode, retained-scope
forgery rejection, wrong generations, barrier-only checkpoint admission, official
readonly/foreign ownership candidate rejection before pointer commit, sticky
publication errors, offline restart generations and persistent host-version checks.
Existing adapter tests cover disabled/nested/codemode/plan/allowlist denial; existing
coordinator tests cover two-window/missing-ack/dirty-view barriers. Additionally the
existing `hosted-excalidraw-archive.test.ts` passed (1 test) with the explicitly
supplied sibling `artifacts/chengzhiyi-pi-excalidraw-0.1.0.tgz`: real 426-resource
package, legacy import/edit/save/restart/disable/uninstall persistence. That test
certifies the manager/package layer, not a full browser-plus-bootstrap end-to-end.

Build succeeds with existing large-chunk/use-client warnings and the parent-owned
worker debug-ID proxy's missing default-export warning. Current default/package
results supersede the older milestone counts above; see the migration report.

Not claimed: full management browser/TUI interaction, real-provider concurrency,
Electron/OS packaging matrix, final Excalidraw parity or release acceptance. The
manager's host-upgrade method currently attempts updates for non-pinned installed
items (including notify policy); policy UX and signed catalog/recovery/GC limits
remain parent-owned acceptance findings, not silently fixed in bootstrap.
