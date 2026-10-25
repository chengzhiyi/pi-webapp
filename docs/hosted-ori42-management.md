# ORI-42 — official plugin management and software-linked updates

## Boundary and integration

Local-only change on `fix/ori42-plugin-management`, sibling `pi-webapp-ori42`, based on `683a4a3`. No parent/shared-alpha source, dependencies or builds were changed. No publish, push, CI dispatch, release merge, or native OS install was performed. Parent ORI-22 owns integration and cross-platform acceptance.

Dependency commits copied into this branch before implementation:
- ORI-40 `06d89b1` → `2ea3f02`: cancellation nonce, AbortSignal propagation, fault/resource tests retained.
- ORI-39 `7e60f42` → `82e91a1`: flat HTTP errorCode/reason preservation and its test. Reuse the original commit when integrating; do not apply both equivalents.

Actual native editor checks use ORI-39's independently built **local**, unpublished Excalidraw archive (plugin fix `c1827f2`, based on `b8f74b1`), SHA-256 `b9a921d1a8e6021cae0236ed86d51706919adbef70e47b671b62832b90c634bd`. The supplied parent artifact was also tested initially, SHA-256 `87b6288b05628e6ac7ebcc73d6611d5412af1d867fb42d39798c6e24e8e9e3cb`; it produced CSP errors and is NOT final passing evidence. Neither source worktree was rebuilt or modified.

## Implementation

- Reuse the host `Button` and `Modal`, existing theme tokens and Plugins page. Remove strategy selector, native confirms, repeated English failure messages and long mechanism descriptions. Keep a short software-update explanation, per-card actions and collapsed technical diagnostics.
- Distinguish metadata 404 (`metadata_not_found`), missing tarball (`tarball_not_found`), no compatible stable release, and registry network/stream failure. One card alert owns an operation failure; installation status is re-read without retrying the mutation. Management/API unavailability is separate from registry unavailability.
- Static official card remains visible offline. Known missing/incompatible releases disable Install with an Unavailable label and retain Check updates. Network failure does not claim the package is unpublished. Successful recheck clears stale failure state. A 404 is the registry's current response, not a promise about future publication.
- Validate legacy notify/automatic/pinned data, normalize it before lifecycle/pair decisions, persist migration at startup under existing locks. The parser-compatible legacy policy endpoint cannot reinstate a pin. Independent Check remains read-only; manual Update remains available.
- Changed software-version startup and controlled business-package combination selection synchronize installed official code, even if local code is already compatible. Preserve absent/disabled behavior and no-downgrade selection. Network/download failure can retain a compatible local pair, but leaves visible diagnostics and no completed-sync marker so a subsequent startup retries. An incompatible local fallback blocks host selection.
- Open editors keep the old generation. Close editors, then Apply pending update; optional immediate reopening still requires the undo-history warning. No page reload, TTL, synthetic flush ack or AgentSession replacement was added.
- Real close-after-pending testing exposed an existing tab teardown defect: React destroyed the iframe before `HostedViewClient.close()` could request its freeze. Preflush alone was insufficient. The tab-close path now retires only that tab's exact session-scoped live frames before DOM removal, and refuses closure on failed acknowledgements. Other controllers/tools and unrelated sessions are not retired. Unit and real App/HTTP coverage exercise this path.

## Verification

Final recorded commands/results:

| Gate | Result |
| --- | --- |
| `npm run check` | PASS |
| `npm run build` | PASS |
| Node `npm test` phase | 422 pass, 0 fail, 1 Windows-only skip |
| desktop test phase | 94 pass, 0 fail |
| complete existing `hosted-*.spec.ts` + new UI cases, Chromium | 26 pass, 0 fail, 2 explicit skips, 0 flaky/retries |
| actual mounted-view shutdown | Clean in final browser run; failures are not annotated away |
| `git diff --check` | PASS |

The browser skips are the opt-in 20-warmup/50-cycle `HOSTED_STRESS=1` reference measurement and the explicitly obsolete per-view long-poll diagnostic. Neither is counted as passed. This issue does not extend ORI-40 resource stress or certify all acceptance-matrix rows.

New Node tests exercise all three **persisted** legacy strategy values through production integration startup, typed installer failures, compatible-local pair updates, offline pair fallback plus next-online-startup retry, disabled/absent/no-downgrade behavior, pending retry after a legacy pin, and scoped live-frame retirement. Existing self-updater npm/desktop business-package tests execute controlled combination staging/restart and offline consumption; these are not OS installer tests.

New browser tests exercise the complete App and HTTP bridge, real integration/installer, with explicitly local registry-response/tgz fixtures. Eight combinations cover zh/en × light/dark × 390/1440: missing metadata, network failure, no compatible release, tarball 404, recheck recovery and successful disabled installation. Each records actual CSS resource URLs, loaded stylesheet URLs, computed flex/border/color and actual theme attribute, verifies no horizontal page overflow, and captures a full-page screenshot. No mocked browser catalog response substitutes for server behavior.

Existing native production browser tests use the exact archive above at 1440/390, retain one real SDK session and page boot identity, and exercise install/enable, tool drawing, native movement/undo/redo, PNG export, Chinese-path save, deferred and explicit-reopen updates, disable/uninstall/reinstall/data retention. The 1440 case additionally updates to a second explicitly local synthetic version, closes the actual editor tab, applies pending code without reopening, and verifies the new generation and unchanged scene. All HTTP/port barriers remain real.

## Actual CSS and public-registry evidence

The original screenshot is retained in `evidence/ori42/original.png`; it proves duplicate messages/native strategy UI, not a missing stylesheet. Final complete App screenshots and `actual-css.json` files show production CSS loaded and themed; the original standalone screenshot's resource-loading state cannot be reconstructed from pixels and is not asserted.

A new real GET to `https://registry.npmjs.org/%40chengzhiyi%2Fpi-excalidraw` returned **404**; headers/body are retained. Public installation therefore remains unavailable at observation time. No trusted source, SHA-512 verification, archive/resource validation, CSP or protocol checks were relaxed to obtain a passing install.

## Retained adverse evidence

All failures remain in the evidence bundle, not counted as passes:
- Initial Node assertions expected retired pin semantics; updated assertions now verify pin migration instead.
- Initial UI run found missing errorCode propagation; fixed by reusing ORI-39's product commit.
- Parent tgz run produced CSP errors and a secondary shutdown failure. Final native runs use ORI-39's independently checksum-verified fixed archive; no CSP weakening.
- Initial close-path test had a hidden tab selector, then exposed the genuine live-frame retirement defect. Primary failure/coordinator snapshots and secondary shutdown failures are retained. The final test records primary and shutdown errors separately and still fails on shutdown errors.
- Initial complete Node run failed real PTY spawn after scripts-disabled install. `npm rebuild` was prevented from running lifecycle scripts by the local npm allowScripts policy. Executed the installed node-pty package's prebuild/post-install scripts in **this isolated worktree**, verified `desktop/check-pty.cjs`, then reran the complete suite successfully. No test or product gate was removed.

## Reproduction

From the isolated host checkout:

```sh
npm ci --ignore-scripts
# Prepare only this checkout's installed node-pty if scripts were intentionally skipped:
(cd node_modules/node-pty && node scripts/prebuild.js && node scripts/post-install.js)
node desktop/check-pty.cjs
npm run check && npm run build
# TGZ is the attached local archive; verify SHA-256 before setting these variables.
HOSTED_EXCALIDRAW_TGZ=$TGZ HOSTED_EXCALIDRAW_SHA256=$SHA \
ORI38_EXCALIDRAW_TGZ=$TGZ ORI38_EXCALIDRAW_SHA256=$SHA npm test
HOSTED_EXCALIDRAW_TGZ=$TGZ PLAYWRIGHT_JSON_OUTPUT_FILE=browser.json \
  npx playwright test test/browser/hosted-*.spec.ts --reporter=list,json
```

Each browser test starts an in-process App/HTTP bridge on an ephemeral port, closes it explicitly and owns its isolated data directory. Paperclip reports no realized execution workspace/runtime service for this issue; no unmanaged persistent preview process was started.

## Not claimed

No npm/public installation success, native OS updater transaction, Windows/Linux packaged/browser execution, OS IME/native file dialog, other browser engines, long-duration resource certification, or full parent matrix completion. Final delivery is this bounded local fix, full source/patches and reproducible evidence for parent integration.
