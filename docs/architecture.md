# Source ownership and builtin plugins

## Layout

```text
src/adapters/pi/             Pi-loadable entry; delegates application startup
src/host/server/
  bootstrap/                Application composition and Pi event integration
  transport/                Loopback HTTP, bearer/origin checks and NDJSON
  sessions/                 Foreground/background sessions and lifecycle
  workspaces/               Workspace registration and directory selection
  plugins/                  Catalog, preferences, request registration and teardown
    hosted/                 Verified plugin packages, workers, state and view recovery
  models/                   Provider authentication and model configuration
  attachments/              Conversation attachment storage
  updates/                  Launcher update integration
src/host/client/            Conversation shell, navigation, settings and plugin management
src/plugins/builtin/
  git/{server,client,contract}/
  files/{server,client,contract}/
  terminal/{server,client,contract}/
src/contracts/              Host wire DTOs, event validation and workbench contributions
src/platform/telemetry/      Shared diagnostics implementation
web/src/                    Browser bootstrap and common UI/design primitives
bin/                        CLI launcher
desktop/                    Electron shell
```

Source ownership is separate from execution: `server` runs in Node and `client` in the browser. It does not imply separate deployed services or an npm workspace per capability. `dist/extension.js`, `web/dist`, the Pi package declaration and launcher entry points remain unchanged.

## Contribution ownership

`src/plugins/builtin/server.ts` and `client.ts` are the builtin composition roots. Excalidraw is an optional independently installed hosted plugin; see [diagrams.md](diagrams.md) for data and persistence and [plugin lifecycle and update recovery](plugin-update-recovery.md) for ownership. `builtinAgentTools` supplies builtin tools to both the foreground extension and retained SDK sessions. The hosted SDK adapter separately publishes capability-qualified tools; execution uses the owning plugin's permission policy. Workbench artifact resolvers map plugin links to typed, owned tabs. The transport dispatches through `ServerPluginRegistry`; it does not import Git, file or terminal request implementations. Each server registration owns its request routes, domain validation and teardown. Existing `/api/workspace/*` and `/api/terminal/*` routes remain compatible aliases; bounded non-streaming operations also accept the common `/api/plugin-action` envelope with a builtin plugin ID and action name.

Builtin browser modules use `defineWebPlugin`, API v1 validation, synchronous activation and scoped cleanup just like external browser modules. The additive, host-owned `workbench.apiVersion: 1` contribution declares a guide entry, panel kinds, renderers and optional titles. `src/contracts/workbench.ts` owns the TypeScript definitions. Unsupported contribution versions and duplicate panel kinds fail that plugin's load. Existing protocol-v1 slots, actions and interactions remain supported; this does not modify the published `@chengzhiyi/pi-web-protocol` package.

The workbench owns tab/session identity, docking, focus and generic tab resources. A plugin supplies its own model, disposal and active-chat hooks. Closing a tab disposes its resource; switching chats retains resources and changes activation. Disabling a builtin closes its owned tabs across retained chats. Shared panel styles live in `web/src/ui/workbench`, not another capability's private directory. Git's untracked previews use the Files module's explicit bounded-reader export, not its UI enablement gate.

## Management and switch semantics

The sidebar's Plugins entry sits directly below New session and opens a global management panel, with the same selected-state and collapsed-rail treatment as other sidebar panels. Settings does not duplicate this entry. Selecting a chat or creating a new session returns to the conversation; plugin details only navigate back to the plugin list, without a separate Back to conversation button. Its centred package rows, independent switches, status copy and detail navigation follow the local DSH checkout at `687f282e86`, specifically `packages/client/ui-plugin-manager` and `ui-primitives/Switch`; the implementation uses this project's bridge, tokens, locale and modal primitives, not DSH's Cordis/runtime dependencies.

Builtin opt-outs persist in Pi's `pi-web/plugins.json` below the agent data directory. The scope is global to this service, not a per-chat authorization policy. The authenticated mutation validates the selected session, all known retained chats being idle, the last configuration revision and the absence of in-flight capability requests or agent starts. Writes use a sibling exclusive lock and atomic rename, reject stale memory/disk snapshots, and are never automatically retried. Other already-running services keep their own effective state; a disk change by another service requires restarting a stale service before it can write again. Lock files record the writer PID and creation time. They are never automatically stolen: after a crash, first stop **all** Pi services using that agent directory, then remove only `pi-web/plugins.json.lock` below that directory and restart. Do not delete a lock belonging to a live writer; refreshing or restarting without clearing an orphaned lock cannot resolve it. A failed or uncertain request leaves the UI unchanged until an explicit refresh reads authoritative state.

Disabling removes the module from the enabled browser catalog and rejects both its legacy endpoints and common action envelope. Terminal disable requires confirmation and closes the service's terminal streams and PTYs; re-enable starts no old processes. `plugin_state` NDJSON updates refresh browser plugin activations without reloading the document, preserving composer drafts. Management invalidations received during an initial read, refresh or mutation are coalesced into one subsequent authoritative read; they never replay a mutation. Idle-time toggles are not arbitrary code unloading or a sandbox. External shells/editors and independently started TUI work remain outside this host's operation coordination.

External Pi Web plugins appear with their runtime ownership described. Their switches are read-only: the current external Pi protocol does not expose independently safe runtime teardown. Use Packages & extensions to add/remove those Pi packages and reload resources. Hiding their browser entry must not masquerade as disabling their tools or background runtime. This page does not manage ordinary Pi extensions that have no Web manifest.

Hosted protocol-v2 packages have a separate, explicit worker/state lifecycle and
can be independently installed, updated, disabled and uninstalled. Compatible
plugins do not follow every host patch release. Only actual protocol/data
conflicts participate in host pair selection. A host update owns a reversible
worker handoff lease, while the plugin broker continues to own data. Cancellation
restores only an exactly matched host selection pointer and retains recovery
journals. View retention never claims an unconfirmed drawing was saved.

Model requests use the model transport interface. Proxy selection and redacted
network diagnostics do not depend on plugin update state. A plugin-local
publication failure denies that plugin's admission and releases the shared Agent
barrier so ordinary chats remain available. The shared barrier is held only for
bounded registry changes and the final host handoff; failure releases it.

Disabling Files or Git controls that capability's host surface, not filesystem or executable permissions. Other enabled capabilities may still perform scoped reads; agents and external terminals may still run system Git. No workspace or session files are deleted by plugin switches.

## Compatibility and verification

The host session DTO remains schema v1; the new `plugin_state` envelope is validated separately from plugin API/workbench versions and extension-reload protocol metadata. Browser code imports wire types, never Node/Pi runtime objects. Source moves update build hashes, private source-map ownership/probe paths, tests and both TypeScript compiler faces.

`test/architecture.test.ts` guards thin Pi entry and registration-based dispatch. Plugin-management tests cover authentication, origin/session checks, stale revisions, persistence, failed saves, busy operations, common action aliases and terminal cleanup. Browser tests cover detail navigation, confirmation, draft retention, persistence and responsive layouts; the existing files, Git, terminal and background-session regressions remain required.
