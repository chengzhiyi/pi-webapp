# Hosted v2 installation and real-package integration

This is a second engineering milestone, **not final full-hot-plug acceptance**.
The service and authenticated HTTP routes are implemented. `pi-host.ts` has not yet
connected the service, frontend coordinator or dynamic Agent adapters. Existing
builtin drawings remain registered until parity and migration are verified.

## Modules

- `official-catalog.ts`: offline metadata only, trusted exact package identity,
  compatible stable-version selection, explicit independent/host-update policy.
  Never follows `latest`, installs absent plugins during host updates, enables
  disabled plugins, or silently downgrades a newer compatible version.
- `versions.ts`: a bounded, fail-closed stable semver grammar (exact versions,
  comparators, caret, tilde and OR). Unsupported syntax is incompatible, not an
  optimistic match. Prereleases are excluded from this first stable channel.
- `archive.ts`: bounded gzip/tar extraction, validates every header/path before
  writing, checksum/UTF-8/PAX support; no shell tar command, install hooks,
  links/devices/sparse files, traversal, duplicate or ancestor collisions.
- `installer.ts`: same-origin HTTPS registry only, redirects forbidden, bounded
  streaming responses, mandatory SHA-512 SRI, resource/identity verification,
  private staging, immutable digest-qualified versions, atomic installation
  index and journal recovery. Lifecycle scripts and installed runtime dependencies
  are rejected: first-party hosted packages must ship prebuilt self-contained code.
  This does not establish registry-publisher provenance beyond the curated catalog
  and registry TLS/SRI; signed catalog/key rotation is a separate release concern.
- `manager.ts`: separates install from enable; owns supervisors, startup/offline
  use, exact-version management, pending edits, scoped invocation, policies,
  independent update and host-upgrade reconciliation. Uninstall removes code only;
  data, legacy source and workspace files live elsewhere. This service never
  reloads Pi sessions or the parent page.
- `routes.ts` plus `transport/bridge.ts`: optional production HTTP handlers behind
  the bridge bearer token, Origin/JSON validation and bounded input; preserves
  domain error status/reason. Authenticated scope still must be resolved by the
  `pi-host` callback; wire cwd/workspace fields are not forwarded.
- `legacy-checkpoints.ts`: read-only aggregation of the old per-draft envelopes,
  exact cwd/session and filename checks, budgets and shared legacy scope lock.
  A durable marker fences the current builtin implementation before import;
  the external plugin owns scene/schema validation and CAS. Old bytes are retained.
  All pre-marker binaries must be stopped before migration: markers cannot fence
  old code which does not know about them.
- `errors.ts`, worker and IPC: preserve additive `status`/`reason` so unavailable
  drawings stop polling and stale candidates cannot be mistaken for success.
- `build.mjs`: ships standalone `dist/hosted-worker.js` alongside the extension,
  with the same private-source-map/debug-ID build discipline. No plugin code is
  imported into the host process.

Package resource paths accept both `./dist/...` and `dist/...`, normalize to one
inventory key, and reject aliases/duplicates. The actual delivered plugin uses
`./dist/...`; the fixture originally used `dist/...`. The real-archive test exposed
and fixed this integration mismatch.

## Bridge integration interface

`BridgeHost.hosted?: HostedBridgeHandlers`:

- `inventory()` -> UI catalog; the browser DTO adapter will be connected after
  the frontend child delivers `src/contracts/hosted-plugins.ts`.
- `manage({pluginId,operation,version?})`, operations install, enable, disable,
  update, uninstall, check and retry. No cwd or scope accepted from a client.
- `action({sessionId,pluginId,generation,action,input})`: resolve session into a
  retained authenticated workspace scope, then call manager.invoke. Never expose
  manager.flush as a generic route; only a registered freeze barrier can admit it.
- `views(body)`: connect the all-window coordinator after its implementation lands.
- `asset(path)`: use manager.assetRequest, never direct arbitrary filesystem reads.

Routes: GET `/api/hosted-plugins`, POST `/api/hosted-plugins/{manage,action,views}`.

Inventory includes `assetBase`, `document`, `controller` and `digest` when active.
Asset base is `/hosted-plugins/<encoded-id>/<random-capability>/<digest>/`. Append
package-relative document/controller paths to this base. Capability rotates on
committed generation, so old frames cannot keep loading old assets. Asset reads
recheck every hash/size and exclude the backend entry. No session data is served.
Only capability-qualified hosted resources receive `frame-ancestors 'self'`;
parent CSP remains `frame-ancestors 'none'`, scripts remain same-origin and
unsafe-eval/remote script or font sources are not enabled. Native browser/CSP
acceptance remains necessary after final host wiring.

## Reproduce exact delivered package test

Build the external plugin separately; provide its exact tgz explicitly:

```sh
HOSTED_EXCALIDRAW_TGZ=/absolute/path/chengzhiyi-pi-excalidraw-0.1.0.tgz \
  node --import ./test/setup-env.mjs --experimental-strip-types --test \
  test/hosted-excalidraw-archive.test.ts
```

Default runs skip this cross-repo test when no artifact path is supplied. They
must not silently resolve a live sibling or claim registry installation. Tested
artifact from plugin commit `6328c63` has SHA256
`87b6288b05628e6ac7ebcc73d6611d5412af1d867fb42d39798c6e24e8e9e3cb`.

The test extracts and verifies the actual 426-resource package into private
versioned directories, launches its actual backend in the host child-process
wrapper, imports legacy checkpoints, syncs a draft revision, saves a Chinese
workspace filename, checks error propagation and asset capability revocation,
defers replacement while editorOpen, switches generation, rejects stale calls,
shuts down and restarts, disables/uninstalls/reinstalls, and recovers the same
draft revision without changing the saved file. It is offline; no registry
install, npm scripts, publication, browser drawing/PNG or real AgentSession is
involved. Those are distinct acceptance layers.

## Remaining release gates

- Connect manager/routes to real SDK/TUI service bootstrap and retained scopes;
  integrate safe Agent batch admission and every browser view's flush/freeze.
- Integrate the frontend catalog DTO, official settings card and iframe UI.
  Check CSP/native editing/IME/export/focus with the actual bridge.
- Disable builtin registration without dual ownership; migrate plugin IDs,
  historical cards and browser backup aliases; only then remove root editor
  dependency/fonts/build. First-install zero-editor-download is not yet satisfied.
- Cross-schema migration/rollback still fails explicitly. Crash runtime/transaction
  locks are not auto-stolen; operator recovery UX and crash-stage matrix remain.
- Installer cleanup leaves uncommitted immutable orphan code inert for retry.
  Version retention is bounded at 16, not the desired current+previous default;
  reference-aware GC for versions and state snapshots remains to implement.
- Reconciliation policy exists but is not yet called by the host update/startup
  path; disabled intent survives, and registry failures leave current code/data.
- Complete A01–A25 including real browser/Agent/desktop platform matrix and SLOs.

No release/push/merge is authorized by this milestone. The protocol is still a
locked verification-only snapshot, now `0.2.0-dev.1` from `6328c63` (no npm publish).
