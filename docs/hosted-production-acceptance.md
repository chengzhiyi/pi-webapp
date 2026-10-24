# Hosted Excalidraw: production integration acceptance checkpoint

**Historical checkpoint, not current status.** Subsequent parent integration passed
the strict-CSP font fix and GC acceptance (see task provenance); ORI-31 removes
the builtin and verifies optional-default migration and clean installation.
Current bounded results are in [migration verification](hosted-excalidraw-migration.md).
The CSP failures and builtin retention below describe this older checkpoint only.
Do not promote the remaining A01–A25 matrix to a full release pass.

ORI-22 implementation checkpoint, not release acceptance. The user authorized implementation, not npm publication, release-branch merge or push. Shared alpha remains untouched. Default builtin diagrams and root editor dependencies are deliberately retained until the migration/parity gate passes.

## Delivered in this checkpoint

- Integrated ORI-28 source commit `702a3dc` as `1a6e3ad` on the parent feature branch.
- `5d07487`: separate management intent serialization from the actual all-Agent switch barrier. Manager download/verification can proceed without blocking existing tools or browser edits; only replace/disable/shutdown freezes admission. Tests hold the archive download open and execute an old-generation browser action while an old-schema SDK batch remains running.
- A committed publication error remains sticky for new work, but graceful shutdown may drain and release the worker/runtime lock without disabling or rolling back the accepted generation. Regression exits normally; no test-force-exit is used for verification.
- Explicit disable/uninstall closes open editors after every view acknowledges its flush. Host shutdown likewise flushes open views, rather than treating shutdown as an automatic upgrade that must wait for editors to be manually closed. Busy or disconnected views still fail closed; there is no dirty-view TTL.
- Opening the plugin management page now HIDES, not unmounts, the live dock. Otherwise React destroys the iframe before its asynchronous cleanup can checkpoint, leaving a stale server capability and blocking the next switch. Native undo is preserved during a pending update.
- A frozen old-generation view CLOSES with its existing capability without sending a forbidden old-generation CHANGE. Duplicate poll/unmount closes are idempotent. Removed/replaced iframes own realm teardown; do not enqueue a doomed remote dispose RPC into a destroyed document.
- Managed official cards use host theme tokens and responsive controls rather than unstyled browser buttons.
- Plugin `dcf42cb`: clean tool/editor observers adopt authoritative sibling checkpoints; dirty writers keep local geometry/backups and remain protected by revision CAS. Separate realms no longer show a false "another canvas updated" conflict for every legitimate hand edit.

## Verification

Host `npm run check` and `npm run build` passed. Full `npm test`: Node **362 passed, 1 Windows-only skipped**, desktop Node **90 passed**, total **452 passed, 1 skipped**. The real external archive test explicitly received the original `6328c63` tgz and was NOT skipped. This is not a packaged Electron acceptance result.

Plugin `dcf42cb`: check/build/pack passed; **12/12** Node tests passed, including clean observers following sibling edits and stale dirty writers rejected without losing their recovery scene.

New `test/browser/hosted-production.spec.ts` loads the COMPLETE built host App, actual authenticated HTTP endpoints, actual supervisor/child process and archive assets, actual retained SDK session and deterministic SDK model transport (no external provider request). Registry bytes are supplied by an in-process test fetch; first release is the actual archive, the second is an explicitly local synthetic `0.1.1` of identical code/resources. It is NOT evidence of a published npm upgrade or signed provenance.

At both 1440px and 390px, the lifecycle assertions reached: offline official card/no code download → UI install disabled → enable → real SDK drawing tool/result iframe → native hand edit/undo/redo → native PNG download → workspace save to Chinese path → default update stays pending with editor open → explicit undo-warning reopen → generation+1 with scene/revision equality → same parent boot nonce and exact AgentSession object → disable hides tools and destroys frames → uninstall retains file bytes → reinstall recovers the same scene. New realms are awaited through real registration/status acknowledgements before the next management action, not a fixed sleep.

**The browser tests still FAIL** their final zero-pageerror assertion: the original package's font subsetting worker executes Emscripten `new Function` under production `script-src 'self'`. Previous route-intercepted frame tests lacked production CSP and did not catch this. Do not relax CSP or count the lifecycle assertions as a clean E2E pass. ORI-30 owns the checked non-eval font fix and strict-CSP browser regression. ORI-29 owns reference-aware version/state GC.

Reproduce (explicit artifact path):

```sh
npm run check
npm run build
HOSTED_EXCALIDRAW_TGZ=/absolute/path/to/plugin.tgz npm test
HOSTED_EXCALIDRAW_TGZ=/absolute/path/to/plugin.tgz npx playwright test test/browser/hosted-production.spec.ts
```

## A01–A25 disposition (no row is a full release pass yet)

| Item | Current evidence / remaining gate |
| --- | --- |
| A01 | Offline card verified; FAIL final default zero-editor dependency/artifact budget (builtin/root library still retained). |
| A02 | Full host lifecycle identity assertions reached; BLOCKED on zero browser errors, actual production bootstrap+packaged installation parity. |
| A03 | Real SDK/TUI direct/nested/codemode and hidden tombstone tests pass; retain full product acceptance scope. |
| A04 | SDK policy tests pass for plan/allowlist; real plan-mode v1 package end-to-end still required. |
| A05 | Retained/background SDK batch uses old worker while update waits, no reload; long provider-stream/multi-window production scenario remains. |
| A06 | Chinese simple scene/revision preserved across full UI generation switch; complete 100-element/group/viewport normalized-hash matrix remains. |
| A07 | Frame busy-flush and IME synthetic rejection verified; actual composition/drag plus composer-input preservation matrix remains. |
| A08 | Pending editor and explicit reset warning exercised; native undo/redo exercised; repeated multiwindow behavior remains. |
| A09 | Real SDK new scene materialization exercised; domain tests cover candidate/stale protection; complete hosted streaming/accept/reject browser suite remains. |
| A10 | PNG, workspace save, undo/redo exercised; strict-CSP font failure BLOCKS; full import/source/transparent export/backups/themes matrix remains. |
| A11 | Scope/generation/CAS negative tests pass; complete two-browser-window conflict/reconnect recovery remains. |
| A12 | Installer/manager failure tests pass; full cancellation/disk-full/network interruption matrix remains. |
| A13 | Archive/resources negative tests pass; production CSP remains strict; fix package code, not the policy. |
| A14 | Broker/runtime tests fence old writes and files; extend end-to-end stale callback injection. |
| A15 | Precommit failure retains active pointer; cross-schema update explicitly refuses rather than pretending migration/rollback. |
| A16 | Generic journal recovery tested; exhaustive prepare/commit/cleanup crash matrix and abandoned lock operator workflow remain. |
| A17 | Stable compatible selection/no downgrade tested; real registry UI diagnostic/policy UX remains. |
| A18 | Startup once-per-host-version reconciliation wired; full paired application updater and visible independent/host-upgrade policies remain. |
| A19 | Real archive lifecycle and complete UI retain files/scene on uninstall/reinstall; clean E2E still CSP-blocked. |
| A20 | Generic 50-loop process test exists; reference-aware GC, combined frame/process/heap cycles remain (ORI-29). |
| A21 | Real SDK/TUI factories and retained sessions tested; interactive terminal acceptance remains. |
| A22 | NOT RUN: packaged macOS/Windows/Linux Electron matrix. |
| A23 | Chromium full App lifecycle exposes CSP failure; other claimed browsers NOT RUN. |
| A24 | Legacy checkpoint import/one-writer lock marker tested; complete ID/history/localStorage migration and builtin removal remain. |
| A25 | NOT RUN: specified reference-machine performance/bytes/CPU/memory matrix. |

After dependencies deliver, the parent integrates and reruns strict browser acceptance, completes migration and default builtin/root-dependency removal, verifies the clean package/dependency graph, and continues the remaining matrix. None of these steps requires repeating the existing implementation authorization. Publication remains separately gated.
