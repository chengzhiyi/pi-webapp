# ORI-27: long-lived hosted tools (SDK 1.3.0)

This patch supplies a **generic host adapter**, not production Excalidraw activation.
Built-in drawings remain unchanged. Never register both implementations' names.
No plugin module, renderer, worker object or editor code is imported here.

## Public seams

`HostedAgentAdapter` receives a host `HostedAgentService`:

- `policy(pluginId, authenticatedScope)` returns enabled, optional tool-name
  allowlist, planMode, exposure and allowNested. Defaults: direct, nested denied.
- `invoke(pluginId, request, signal)` returns a normal SDK tool result. It must
  route to the correct scope's supervisor and map domain output into
  `{content, details}`. Do not treat a worker's arbitrary value as a tool result.
  Supervisor invocation does not currently accept cancellation: reject before
  starting if aborted; once started, preserve the supervisor's lease until actual
  completion, even if the caller aborts. Do not report rollback on timeout.
- Descriptors are data-only `HostedToolDescriptor`s from the supervisor's verified
  `tools`. `action` is forwarded unchanged; parameter schemas are cloned without
  flattening, permissive wrappers or action/input envelope substitution.
- `freeze()` synchronously closes admission and waits for **all** registered
  sessions (including retained/background SDK sessions and mounted TUI sessions)
  to emit `agent_settled`. Plugin-call idle and `agent_end` are insufficient.
- `change(pluginId, descriptors)` requires the frozen/settled boundary. Empty
  descriptors remove exposure, replacing registrations with hidden host-only
  tombstones. No stale action/schema/renderer/worker closure remains registered.
- `thaw()` reopens admission and wakes blocked direct SDK/TUI prompts plus host
  prompt queues. Always thaw in a finally block. Policy/exposure changes that
  change discovery must also use freeze/change/thaw, even if schemas are unchanged.
- `invokeAction` applies admission and conservative policy: disabled, plan mode
  and tool-only allowlists deny actions. The service must additionally validate
  the actual UI action against a **host-owned action allowlist/permission policy**.
  Never route browser-provided scope or a raw unrestricted action directly here.

`readonly` is an unverified plugin hint. The parent must verify trusted package
policy before accepting it as plan-mode permission. Execution-time policy checks
also deny calls after a permission revocation before a discovery refresh occurs.
Nested calls use the normal SDK `tool_call` hook (`parentToolCallId`), including
codemode's `ctx.executeTool`; hidden tools remain unreachable even if activated.

## Required supervisor ordering (important integration finding)

The baseline supervisor (`6a604e6`) marks itself **draining before calling its
freeze hook**. Calling only `adapter.freeze()` from that hook is NOT sufficient:
an already-admitted Agent batch may still need to invoke old-schema tools, which
would then be refused by the draining supervisor.

Serialize management operations at the parent and **pre-freeze the Agent adapter
before calling supervisor.replace/disable**. Keep the old supervisor active while
awaiting that barrier. Do not freeze from inside an active Agent tool/extension
command that waits for itself to settle; schedule management externally.

```ts
await adapter.freeze(); // gate closes now; old batches finish on old supervisor
try {
  await supervisor.replace(pkg); // or disable()
} finally {
  adapter.thaw();
}
```

With that outer barrier, wire the supervisor's hooks as follows:

```ts
const hooks = {
  canSwitch: () => views.canSwitch(),
  freeze: async () => {
    if (!adapter.isFrozen) throw new Error('Missing outer Agent barrier');
    await views.flushAndFreezeAll(); // includes every mounted frame, authenticated FlushBarrier
  },
  committed: async active => {
    adapter.change(pluginId, active.enabled ? supervisor.tools : []);
    await views.reconnect(active);
  },
  resume: async () => { await views.resumeOldGeneration(); },
};
```

Preflight name conflicts **before committing persistent activation**, using
`adapter.validateChange(pluginId, candidateDescriptors)` while holding the parent
management serialization. This does not mutate registrations and is repeated
by `change`. Parent must obtain verified candidate descriptors before commit;
the baseline supervisor currently exposes only active tools, not a candidate
precommit hook. Until that parent-owned integration seam exists, do not expose
production enable/update as atomic or enable a conflicting builtin name. `change`
rejects any unrelated builtin/extension name and cross-plugin name reuse,
including tombstoned ownership. It also detects a different extension taking the
visible name after registration (schema identity mismatch) and never overwrites
that owner. The SDK resolves duplicate extension names first-extension-wins;
trusted external extensions can still intentionally shadow each other. The
adapter is not an isolation boundary for malicious in-process extensions.
The adapter's change-time preflight is the final defense, not a transaction with
supervisor activation: the baseline supervisor swallows committed-hook failures
into `reconnectRequired`. Parent must surface that failure and keep normal plugin
admission closed if publication failed; never claim successful tool activation.

No automatic fallback to reload/rebuild exists. An unsupported SDK fails before
registration. Freeze deliberately waits rather than aborting/killing old batches;
if an operator cancels a management attempt, leave the old runtime active and
thaw only through the serialized parent coordinator. Never proceed on timeout.

## SDK / WorkspaceSessions wiring

The eighth, additive constructor argument is optional; existing callers retain
their current behavior:

```ts
const hosted = {
  adapter,
  scope: (cwd, sessionId) => ({ cwd, sessionId, workspaceId: trustedWorkspaceId(cwd) }),
};
const sessions = new WorkspaceSessions(publish, fallbackModel, trusted,
  reportError, telemetry, changed, nonConflictingCustomTools, hosted);
```

WorkspaceSessions injects one inline factory before SDK creation, attaches after
creation, tracks every retained runtime regardless of foreground selection, and
releases bindings on shutdown/failed creation/disposal. New sessions receive the
current descriptors without reloading any old session. Queued prompts resume on
thaw. Normal send/resume reject during freeze; direct SDK prompts wait at the
`before_agent_start` gate and use the post-switch loadout. Already-admitted runs
may finish automatic follow-ups/retries before the final settlement.

For a different SDK embedder use `adapter.extension(scope)` as a
`DefaultResourceLoader.extensionFactories` entry, then `adapter.attach(session)`
before prompting. Keep the returned release callback until actual session
shutdown. Release is lifecycle cleanup, **not** a way to disable a live session's
tools. Shutdown must abort/wait for work first. SDK dispose without emitting
session_shutdown must still invoke the release callback.

## TUI / pi-host wiring (parent-owned file, not modified here)

Register from the existing long-lived host extension, using the real context's
session ID, trusted cwd/workspace and the same shared adapter coordinator:

```ts
let releaseHosted: (() => void) | undefined;
pi.on('session_start', (_event, ctx) => {
  releaseHosted?.();
  releaseHosted = adapter.mountTui(pi, {
    cwd: ctx.cwd,
    sessionId: ctx.sessionManager.getSessionId(),
    workspaceId: trustedWorkspaceId(ctx.cwd),
  });
});
pi.on('session_shutdown', () => { releaseHosted?.(); releaseHosted = undefined; });
```

Do not call `mountTui` during an active turn. Commands that initiate management
must not await their own unsettled run. No terminal rendering API is needed;
the tools work in print and TUI with the same policy and batch barrier.

## SDK verification and tests

Read the installed 0.87.1 README, extensions/SDK/TUI and session/message docs,
and dynamic-tools / SDK examples; verified against the **actual installed 1.3.0**
`extensions/types.d.ts`, loader, runner and agent-session implementation:

- registerTool replaces this extension's definition and refreshes the current
  AgentSession registry; no reload/shutdown is necessary.
- hidden means unreachable, unlike inactive direct/codemode tools.
- direct -> codemode retains an old active name in SDK refresh; adapter explicitly
  removes owned non-direct names from the active set without changing unrelated tools.
- nested calls traverse hooks; `agent_settled` follows recovery/automatic work.
- SDK validation can coerce primitive values; schemas are forwarded exactly,
  not claimed to impose stronger validation than the SDK. Missing required
  arguments are rejected in real-provider-loop tests.

The adapter deliberately pins `VERSION === '1.3.0'`. Reverify these contracts and
update that guard before supporting another SDK; do not quietly accept a version
without hidden/nested/dynamic registration support.

```sh
node --import ./test/setup-env.mjs --experimental-strip-types --test \
  test/hosted-agent*.test.ts test/background-sessions.test.ts \
  test/diagram-tools-sdk.test.ts test/hosted-plugins.test.ts \
  test/prompt-queue-bridge.test.ts
npm run check
```

17 tests passed. New deterministic no-network tests exercise real SDK model/tool
loops, TUI mount lifecycle in print mode, same session identities/no dispose on
enable/replace/hide, retained background old-schema batches, plugin-idle vs
settled, direct prompt admission while frozen, both retained/new session schemas,
exact schema required-input validation, direct/codemode/nested denial, plan mode,
allowlist, execution-time disabled policy, hidden activation resistance,
cross-plugin/builtin/late foreign ownership conflicts and cleanup.

Not verified here: real terminal UI interaction, full application's management
routes, browser all-window freeze/reconnect, real provider networking,
Excalidraw enabled end-to-end, platform packaging or releases. Parent owns
bootstrap/service/supervisor integration and these acceptance gates. No npm
install, publish, push, merge, builtin drawing removal or unrelated code edits.
