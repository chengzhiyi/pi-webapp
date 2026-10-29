# Hosted tool UI (2026-10-29)

## Scope and acceptance

Fix collapsed drawing cards retaining a 240px iframe, inline parameter details,
and ambiguous uninstall confirmation. The host owns generic card chrome,
parameter dialogs and operation confirmations; the independently installed
plugin owns preview/editor rendering and business state. No host code may inspect
the plugin DOM. Retain authenticated scoped RPC, CAS persistence, all-view save
barriers, version checks, archive integrity and the iframe adapter.

Acceptance: repeated collapse uses only header height; long parameters use a
viewport-bounded, themed dialog with focus containment and restoration; uninstall,
disable and immediate update explain the requested operation. Actual packaged
plugin tests must exercise preview → editor → edit → save → close/update, failure
retention, multiple mounts and disposal.

## Ordered implementation

1. Add failing browser regressions and an additive tool UI capability contract.
2. Negotiate host tool chrome and content-size reports over the existing private
   MessagePort. Keep collapsed frames mounted and coordinated. Render parameter
   text from host-owned tool inputs/results, never plugin-provided HTML.
3. Distinguish management confirmation copy; preserve the operation/save barrier.
4. Test Shadow DOM with the pinned real editor, audit global resources/lifecycle,
   and document the smallest safe production boundary. Do not migrate the editor
   merely to remove the iframe.
5. Run independent build/package checks, focused browser and lifecycle suites,
   type checks and domain/transport tests; record actual coverage and limitations.

The pre-existing untracked `.pi-tasks/` directory is outside this change. No
publishing, pushing, deployment or release-version change is authorized.

## Decision: host chrome, isolated plugin content

Production remains data/RPC + iframe content. The host owns tool chrome,
parameters, mount-scoped notifications and existing JSON-contributed sidebar/panel
routes. The plugin owns previews, candidates, native editing and business state.
Generic host UI imports no Excalidraw code and never reads its DOM or React state.
The reviewed official catalog in integration.ts remains unchanged; opening
arbitrary additional hosted packages is outside this change.

The card takes ordinary tool call/result data and a child renderer independent of
transport. A future trusted custom element can use this seam after meeting the
lifecycle contract, including registration with the existing view coordinator.
No uncoordinated custom-element loader is introduced in production.

## Additive UI protocol

initialize may include `hostUi: { toolCard: true, autoResize: true,
notifications: true }`. Services are individually optional. Runtime protocol stays
1; no new required backend capability or protocol npm release is needed.

| Private-port method | Input | Host behavior |
| --- | --- | --- |
| toolPresentation | `{title: string}` (nonempty, ≤160 characters) | Tool mounts only; enables native host chrome. Plugin renders only preview after acceptance. |
| resize | `{height: number}` (finite, 0–4096 CSS pixels) | Tool mounts only; rounds up with a 1px floor. No DOM inspection. |
| notify | `{message: string, level: "info" \| "error"}` (≤4000 characters) | Dismissible mount-owned status/alert; no HTML. |

All messages use the origin/source/mount/generation-bound private MessagePort and
grant no backend authority. Dead mounts reject late UI requests. Parameters are
text from the host's current call/result, never plugin-provided HTML. Theme and
language continue through initialize/update. The body-portaled dialog uses host
tokens, a bounded scroll area and shared focus containment. Updated contents do
not recreate the dialog owner.

The plugin measures its own auto-height root with ResizeObserver and coalesces
reports with requestAnimationFrame. Tool roots use auto height, avoiding feedback
from the iframe viewport that prevents shrinking. Expanded previews keep scroll
limits. Collapse hides the host body without unmounting its iframe, retaining
readiness, edits and barrier membership. Expand does not create a new identity.

## Compatibility

- New host + new plugin: native card/dialog and automatic preview height.
- New host + old frame: no opt-in or duplicate header; existing 240px legacy
  rendering stays supported. Old collapse/dialog bugs require a plugin update.
- Old host + new plugin: legacy chrome plus a real native HTML dialog, necessarily
  bounded by the old iframe viewport. Both updates are needed for the full fix.

## Lifecycle and upgrade

1. Register the authenticated view, connect the immutable document and exact
   identity, negotiate optional UI, and acknowledge actual realm readiness.
2. Update call/result, locale, theme and visibility within the same session.
   Folding is presentation only; it neither creates nor closes a view.
3. Send/close/disable/uninstall/replacement retain the all-view flush/freeze
   barrier. Failed saves retain views/generation. Ordinary updates wait for
   editors; immediate update warns of clearing native undo/redo history.
4. Dispose removes the host overlay/focus listeners. Plugin cleanup disconnects
   the size observer, cancels its queued animation frame, unmounts React, disposes
   models and removes timers/global events/ports. React effects release thumbnail
   blobs, polling, theme observers, beforeunload and Canvas resources. Existing
   pagehide handles realm teardown. Abrupt loss retains unknown-view recovery;
   no clean acknowledgment is invented.
5. Committed generations use fresh iframe realms and digest-qualified immutable
   URLs, avoiding old module state. Catalog/status refreshes retain frames/undo.
   Archive retention/garbage collection are unchanged; assets are not prematurely
   deleted. No production custom-element registry/cache is introduced.

## Web Components / Shadow DOM evidence

The plugin's test/shadow-dom.browser.mjs imports the actual built Canvas and exact
bundled React copy, injects the full stylesheet into an open Shadow Root, opens
native Help, and mounts/disposes two guarded custom elements. It reproduces an
unstyled body portal: Help's .Modal computes to position static, versus absolute
in the real iframe editor; the fixture expands to approximately 9,000px height.
Evidence and screenshot: pi-extensions/artifacts/shadow-dom-probe/.

Concrete additional source constraints:

- canvas-env.ts writes window.EXCALIDRAW_ASSET_PATH; Canvas/vendor font handling
  uses document.fonts. Vendor code queries document.activeElement and creates
  a body-level .excalidraw-tooltip. Shadow DOM redirects none of these operations.
- rpc.ts owns a module-level port/pending map; model.ts owns a registry with
  dispose-all; interaction.ts owns one busy flag. Sharing these unchanged in a
  document couples mounts and disposal.
- Guarding a stable element tag does not upgrade its constructor. Cache-busted
  dynamic import does not unload modules, listeners or FontFaces.

Benefits would include natural content sizing, direct DOM focus integration and
fewer document/React copies for lightweight renderers. The native card/dialog seam
already obtains the main UX benefit without migrating the editor. Trust does not
isolate window/document. A safe editor adapter requires instance-owned RPC/model/
busy/disposal scopes, supported portal and focus roots, scoped styles/font
ownership and a versioned renderer factory, then the same multi-view/native
regressions. These are migration gates, not a claim Shadow DOM can never work.

React stays pinned/bundled inside the independently built plugin (18.3.1); host
React is not injected/shared. The probe deliberately uses the exact plugin
React/ReactDOM pair. A future component adapter must inject CSS per shadow root,
use immutable module-relative assets, explicitly arrange fonts/portals, and pass
locale/theme per instance instead of mutating the host body. Injecting all vendor
CSS into the host to cover escaped portals defeats the intended style boundary.


## Verification record

Executed on macOS with real headless Chromium and isolated temporary workspaces.
Registry/provider transports in hosted browser fixtures are deterministic local
fixtures; SDK sessions, workers, package installation, authenticated HTTP, view
registration, saves and freeze acknowledgments are real. Synthetic upgrade
versions change only test release metadata, not the frontend payload.

| Check | Result |
| --- | --- |
| Host npm run check / npm run build | Passed (existing bundle-size/Sentry proxy warnings remain). |
| Host npm test | 463 Node + 94 desktop tests passed; 5 conditional skips. |
| Actual 0.1.2 archive install/import/save/drain/restart/disable/uninstall | Separately passed with explicit archive/version; not counted as a skip. |
| Plugin repository pnpm check / pnpm test | Passed: 40 script, 7 protocol, 19 Excalidraw, 54 plan-mode tests. Used installed Node 22.23.2 for the repository's transform-types test script. |
| Host browser final UI/management/production/owned-runtime matrix | 11 passed, including desktop/mobile full lifecycle and injected save failure. |
| Host native parity / native compat / viewport parity | 13 passed, including IME events, drag, shortcuts, native source/SVG/PNG, zoom/pan, streaming and competing windows. |
| Pre-change plugin package with new host | Production desktop lifecycle passed; legacy rendering remains available. |
| Exact package verify / independent offline build | Passed; 152 copied dependency versions, no host module resolution, 427 controlled resources. |
| Plugin iframe browser test | Handshake, native drag, busy/flush/freeze/restore/session fence/dispose passed. |
| Strict-CSP archive browser | Passed: Chinese SVG font decode, PNG/source export, frame-local legacy dialog; zero CSP violations, external requests or console/page errors. |
| Shadow DOM probe | Successfully reproduced the body-portal/style incompatibility; two mounts and two disposals, zero external requests/page errors. |

New regression coverage: repeated fold/unfold with unchanged iframe identity;
long parameters at 390px dark/1440px light; Shift-Tab/Tab, Escape, button close,
programmatic focus escape and restoration; two independent cards/editors; native
Chinese text and composition events; actual failed checkpoints preventing tab
close/uninstall/immediate update; retained edits subsequently saved and surviving
replacement; three disable/enable cycles with an open parameter dialog removed,
no host focus-listener growth, no residual host portals and no console errors.

CSP fixture maintenance fixes a stale hardcoded archive version and implements
the existing host-owned download relay in the independent test harness. It does
not relax CSP or change production export code. Host fixtures normalize metadata
for their local synthetic releases. The native/legacy iframe adapters are retained.

Evidence is local and ignored by Git:

- Host artifacts/hosted-tool-ui/: host-tests.log, host-build.log, final-browser/,
  failure-retention/, cleanup/, screenshots/, legacy-compat/.
- Plugin artifacts/shadow-dom-probe/: evidence.json and body-portal.png.
- Plugin artifacts/chengzhiyi-pi-excalidraw-0.1.2.tgz: independently packed artifact.

Not certified: OS-native IME candidate windows, packaged Electron/Windows/Linux
interaction, Firefox/WebKit, live npm/provider networks, or the 50-generation
browser stress suite. Full host tests conditionally skip two external-version
archive gates, hot bootstrap gate and Windows PTY; the exact current archive gate
was run separately. Native IME coverage here is browser composition/text insertion.
The full editor is not migrated to Shadow DOM; required instance/portal/font/cache
work is described above. No package versions, lockfiles, server authorization,
state schema or broker save/coordination rules changed; no publish/push/deploy.

## Refresh recovery UI follow-up

Recovery records previously rendered as unstyled sections before AppFrame. Since
AppFrame consumes 100% of the viewport, those sections pushed the entire app below
the fold, producing document scrollbars and incorrect resize geometry. Recovery
now lives in plugin management, with an explanation and a bounded, themed
details dialog. Recovery never renders before AppFrame or floats over the
conversation. Each discard uses a separate confirmation;
cancel/failure preserves the journal and capability. Dismissing the dialog only
hides details, not the recovery entry.

The optional host view operation `reconcile` returns `recovery: closed` only for
an authenticated, already retired capability (accepted close or explicit discard).
A clean/frozen view or a generation change is not a substitute for the actual
close receipt: its owner may still be active. Subsequent local edits may not have
reached the host. Unknown tokens/server restart/evicted proof records remain
unconfirmed. The in-memory retired-proof cache is bounded to 1024; eviction never
confers permission to discard. Scope checks include user, workspace, session,
mount, generation and token. Old hosts without this operation retain all records.

Browser coverage adds real repeated reloads with checkpoint preservation,
sidebar dragging, 390/1024/1440 viewport changes, and 20 pending records in 320px
Chinese dark/1440px English light dialogs. It checks no document overflow or frame
offset, internal scrolling, cancel focus restoration, failed discard retention,
and automatic removal of server-confirmed closed records. Unit coverage proves
clean-looking/dirty/unknown views cannot be silently retired, and even a
committed old generation needs its actual close receipt before automatic removal.

## Launcher and uninstall follow-up

The workspace adapter previously used a font diamond while management used a
pencil. Hosted cards now carry an optional reviewed `icon` key; the host's shared
artwork registry supplies both surfaces. The offline catalog provides artwork for
absent packages and older hosts. This imports no plugin editor or business code.
The disclosure uses a fixed 24px SVG container instead of baseline-aligned text,
including on narrow screens.

A history renderer's `workbench.entry` is now optional. The drawing history fallback
keeps explicit historical links and tool output readable, but contributes no
workspace launcher. After an authoritative catalog reports disabled/uninstalled,
all owned tabs in retained session docks close. Pending updates, failed catalog
reads and save-barrier failures do not authorize this cleanup. Frozen realms close
through the existing capability flow; no host reads plugin DOM or model state.
Uninstallation displays the authoritative uninstalled state with a Reinstall
action. Reinstall/enable restores access to existing drawings, without reopening
old editor tabs implicitly.

Refreshing destroys a document before asynchronous frame flush/close can finish.
A clean-looking status is insufficient to discard possibly newer local edits.
The recovery list is therefore retained, but only shown inside plugin management,
with an explanation of its effect on disable/uninstall. A `view_barrier` error now
explains the pending save confirmation. Confirmed closes are still removed via
`reconcile`. After a server restart, explicit per-record `discard` may dismiss an
unknown capability; it acknowledges no save, changes no drawing and cannot retire
another live capability. The host never auto-discards records, clears another
tab's storage or weakens the all-view save barrier.

Browser regression: real independently installed Excalidraw in English/Chinese,
1440px/390px, with an unresolved old editor plus an edited live editor. Failed
uninstall retains the editor/package; explicit recovery followed by uninstall
removes the launcher and owned tabs and enables reinstallation. Reinstallation
preserves scene elements and restores the same workspace/management icon. Existing
collapse/parameter regressions additionally measure SVG vertical centering.


Verification for this follow-up: 14 browser cases passed (the 12-case UI set,
plus both corrected production lifecycle cases), 466 Node tests + 94 desktop
tests passed (5 pre-existing skips), targeted final integration/routes/client
checks passed, and typecheck/full build passed. Browser evidence lives under
`artifacts/hosted-tool-ui/uninstall-acceptance`, `uninstall-production`, and
`uninstall-chain`. The existing live preview receives the compatible frontend
without force-restarting its old backend or discarding uncertain drafts. New
server reconciliation/retained-data metadata applies on the next safe restart;
older-backend artwork/reinstall fallbacks remain supported.


## Alpha integration

The alpha merge keeps its existing structured `HostedViewRecovery` contract.
The close-proof cache reports `recovery.state = retired`; unknown authoring
capabilities remain `absent` and need explicit review, not automatic dismissal.
Controller-only records and provably unstarted registrations use alpha's existing
safe retirement/cancellation rules. Editable drafts still require a real save
barrier or an explicit, separately confirmed recovery decision.

Recovery reconciliation runs in a host hook even when management is closed, so
refreshing a controller-only document cannot accumulate lifecycle blockers. Its
UI appears only in plugin management. The themed page dialog retains alpha's
per-view backup snapshots/downloads, opening a drawing for comparison, and
retain-for-recovery action. Retention revokes stale writes without replacing or
discarding a drawing. Both retention and discard use the host modal/focus system.
The merge preserves alpha's per-plugin publication isolation and app-owned update
recovery; it does not replace those changes with older boolean recovery flags.


Alpha merge verification: 513 Node tests and 94 desktop tests passed (5 existing
skips), 35 recovery/lifecycle focused tests passed, and typecheck/full build
passed. Twenty browser scenarios were verified, including controller-only reload,
real dirty-draft backup download and explicit retention, per-view discard failure,
operation confirmations, independent cards/editors, update, uninstall/reinstall,
themed narrow dialogs, and keyboard focus. Browser evidence is in
`artifacts/alpha-merge/browser` and `artifacts/alpha-merge/browser-followup`.
