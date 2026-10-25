# Hosted UI / all-window barrier handoff (ORI-26)

Historical frontend milestone; current optional-default ownership and builtin removal
are documented in [migration verification](hosted-excalidraw-migration.md). The earlier
scope below is preserved as provenance, not the current composition.

This change was an inspectable frontend/coordinator implementation, **not production activation of Excalidraw**. The existing built-in drawings and v1 runtime remain. No tools are registered by the browser. Parent integration must reject duplicate tool ownership before enabling an external replacement; disabling built-in drawings is a separate parity-gated decision.

## Delivered paths

- `src/contracts/hosted-plugins.ts`: JSON catalog/cards, management, action and view DTOs.
- `src/host/client/hosted/`: authenticated fetch, exact-target-origin MessageChannel FrameAdapter, per-mount RPC timeouts, every-frame registry, view long-poll client, controller/panel/editor/tool components, streaming updates, offline official catalog/management UI.
- `PiApp.tsx`: hosted contributions alongside v1, controller mounts, all-frame beforeSend and session-navigation flush; thrown errors preserve the existing composer draft.
- `PluginPanel.tsx`: user tab close first flushes all session frames; failures keep the tab open. Hidden tabs remain mounted and participate.
- `PluginManagementPage.tsx`: independent hosted management section. Catalog failure doesn't disable v1 management.
- `src/host/server/plugins/hosted/views.ts`: one coordinator per plugin, scoped view capabilities, bounded 20-second long polling, 15-second freeze barrier, all-window acknowledgements and generation-aware checkpoint admission. Dirty/disconnected views do not expire.

## Parent-owned route wiring (not edited here)

All routes must use the normal authenticated host transport, origin/CSRF policy, capability checks and existing error serialization. `access-token.ts` supplies the same browser Bearer token. No iframe input supplies cwd/workspace; resolve scope on the server from authenticated session access.

1. `GET /api/hosted-plugins` returns `HostedPluginCatalog`. Include static official cards even if not installed. `installed` is immutable-registry presence, `enabled` is acknowledged intent/runtime state, not synonyms. Return immutable, manifest/digest-qualified `documentUrl` / `controllerUrl`, current integer `generation`, and the package's data-only `contribution` for enabled packages. Only manifest-listed documents/assets may be served; the UI never imports package JS into the host realm. Do not use browser-facing `describe` as authorization policy.
2. `POST /api/hosted-plugins/manage` accepts `HostedManageInput`; returns the updated catalog after acknowledgement. Support install/enable/disable/update/uninstall/check/retry. Default updates call `supervisor.replace()` normally and return `pendingVersion` while editors/workspaces are open. Re-attempt a pending replacement after views close (or an explicit user retry). `reopenEditors?: true` is additive: it is emitted only after the explicit undo-history-reset warning. The parent must call `coordinator.allowImmediateReopen(true)` only for that operation, and reset it on every completion/failure path. Busy interactions and missing acknowledgements still fail. Disable/uninstall must also use this barrier before UI teardown. Never clear workspace files or silently resolve uncertain outcomes.
3. `POST /api/hosted-plugins/action` accepts `HostedActionInput`. Bind its session to authenticated workspace/session; reject stale generation **before invoking**, rather than letting `supervisor.invoke()` substitute the current generation for stale browser input. Preserve `{code,message,status?,reason?}` on error. Normal actions call `supervisor.invoke()`.
   - The host adapter, not the frame, attaches `viewToken`/`mountId` to the envelope.
   - During draining, only admit a host-owned checkpoint-only action allowlist (Excalidraw's `sync`, plus any explicitly reviewed prerequisite reads) when `coordinator.authorizesFlush(input, authenticatedScope)` returns true. Then use the supervisor's host-only `flushAction()` with that authenticated invocation scope. Never expose `flushAction()` based merely on an action name, `reopenEditors`, cwd, arbitrary frame data, or a token outside the active barrier.
4. `POST /api/hosted-plugins/views` parses/validates the DTO and calls `coordinator.handle(input, {ownerId,workspaceId,sessionId})`; owner must be stable across that browser's requests and isolated from other users. Validate session authorization on **every** register/poll/ack/change/close. HTTP request bounds should allow a 20-second long poll. One outstanding poll per view is allowed. Request abort does not forget the view.
5. Compose supervisor hooks with the retained Agent tool-batch gate:

   ```ts
   const hooks = {
     canSwitch: async () => await batchGate.canSwitch() && views.canSwitch(),
     freeze: async () => { await batchGate.freeze(); await views.freeze(); },
     committed: async active => {
       await retainedAdapter.publishDescriptors(active);
       await views.committed(active);
     },
     resume: async () => { await views.resume(); await batchGate.resume(); },
   };
   ```

   The host must not resume new tool batches until the new descriptors/generation are visible. After activation, failures request reconnect; never roll back new-generation edits. Call `views.committed({generation})` only after the broker's active pointer is committed. Browser clients acknowledge, close their frozen old mounts and refetch the catalog to remount. Old registrations remain generation-bound, never mutated into current capabilities.

## Safety/lifecycle semantics

- Each connection is created only after its document load. URL parameters contain exact parentOrigin/pluginId/mountId/generation; only that iframe Window receives the port using the exact target origin. The package validates the corresponding source/origin/identity tuple. Arbitrary window messages are not RPC. Subsequent iframe navigation disposes the connection; port RPC never accepts a caller-supplied session/cwd.
- All mounted realms (controller, hidden workspace/editor and each tool thumbnail) flush concurrently and **all** are awaited even if another fails. Readiness errors/timeouts and a changing mount set fail the send; no composer clearing occurs before `bridge.send()`.
- Immediate reopening clears native undo/redo history; persistent snapshots recover content, not undo history. Default is to wait for editors to close.
- Scope/generation-bound server tokens cannot acknowledge another window's barrier. New registration is rejected during freeze. A lost, busy or negative acknowledgement retains the old generation. Late dirty/busy changes invalidate frozen status.
- Bounded polls stop on network failure instead of busy-looping or replaying uncertain actions. Reconnection is explicit refresh/reload/catalog change. A dirty view is never silently removed by TTL.
- On ordinary tab/session navigation, pre-close flush happens while the iframe is alive; teardown reports clean close and attempts RPC dispose before closing the port. React/browser removal can prevent the final dispose reply; local resources/port are bounded by RPC timeout, and realm removal itself releases editor resources. Abrupt browser/tab/process loss or nonstandard teardown without that pre-close flush can leave an unknown/dirty registration. **Do not auto-clear it**; an explicit recovery/backup/re-handshake policy is a remaining host UX requirement.
- The coordinator is in-memory and owned by one serving host process. This is not a distributed/restart-persistent view registry. Parent must retain/reconcile uncertain views across host restart or require authenticated clients to re-register before allowing a switch. Cross-host broadcasts/persistent recovery and full end-to-end restart/upgrade acceptance are not certified here.
- These are realm/lifecycle boundaries, not a sandbox against malicious same-origin plugin code.

## Verification performed

```sh
npm run check
node --import ./test/setup-env.mjs --experimental-strip-types --test \
  test/hosted-views.test.ts test/web-plugins.test.ts test/hosted-plugins.test.ts
node test/hosted-frame.browser.mjs
git diff --check
```

The browser test uses the host's actual FrameAdapter against the read-only sibling package's prebuilt real Excalidraw frame, served cross-origin through Playwright routes. `HOSTED_PLUGIN_DIST` can override the fixture directory. It exercises exact handshake parameters, native rectangle drag and checkpoint flush, IME-busy rejection, freeze/restore undo warning metadata, session fence and dispose. No registry or external network access is used. Dependencies were symlinked from the sibling host; no install was run.

Unit/integration coverage includes all-frame failure aggregation/readiness/offline errors, mount-set changes, default editor deferral, explicit immediate-mode busy rejection, two-window barrier, missing ack old-preserving timeout, dirty-view non-expiry, owner/scope/generation isolation, checkpoint-only barrier capability admission and bounded polls. Existing hosted subprocess/state tests and v1 discovery test remain green.

Not claimed: complete host enable/install/uninstall/restart/hot-upgrade E2E, full management browser tests, packaged Electron/OS matrix, distributed registry persistence, or every native editor menu/undo/streaming regression. Those require the parent-owned authenticated routes/installer/session adapters and parity decision. No npm publish, push or release merge was performed.
