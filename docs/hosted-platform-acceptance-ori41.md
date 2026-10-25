# ORI-41 — native/browser acceptance (partial, NOT release approval)

> Historical 2026-10-24 run. Current follow-up repairs, successful reruns and
> user-authorized environment skips are in [the follow-up report](hosted-platform-fixes-ori41.md).
> Historical failures below are preserved; they are not the current paired-build verdict.

## Provenance and containment

2026-10-24; host base `683a4a3`; isolated sibling `pi-webapp-ori41`, branch
`test/ori41-platform-matrix`. Plugin base `b8f74b1`, unchanged. Exact supplied
0.1.0 development tgz SHA256:
`932c697f49d87855d5ddc46786c9d0d8ee7b52f64f95af266c46d18ce84d53d5`.
No shared alpha/parent build directories changed; independent npm ci, build,
prepare and app-dir packaging. No push, CI dispatch, registry publication,
release-branch merge, store upload, notarization, system input-source change or
accessibility permission change performed.

## Support discovery

README.md and README.zh-CN.md advertise browser and Electron entry points but do
not enumerate supported browser versions. `playwright.config.ts` only selected
Chromium; that is a test default, not authorization to narrow product support.
`web/src/ui/theme/scrollbar.css` and conversation/input CSS explicitly consider
Firefox, Safari and Chromium. Therefore Firefox and WebKit were tested as
additional engine candidates; maintainers still own the formal browser/version
support declaration. Playwright WebKit is NOT shipping Safari certification.
Installed Safari/Firefox/Chrome exist locally; no Safari WebDriver/UI-control
session was supplied. Official Playwright Firefox/WebKit downloads succeeded.

## Results (do not combine these with historical Chromium passes)

| Target | Actual execution | Verdict |
| --- | --- | --- |
| macOS 26.0 arm64; Node 24.21.0 | npm ci, check, build; normal desktop:prepare + desktop:package -- --dir; deep/strict codesign | PASS build/signature integrity only; ad-hoc, NOT notarized |
| Firefox 155.0, Playwright revision 1543, headless macOS arm64 | 17 original matrix cases: 6 passed, 10 failed, 1 obsolete diagnostic skip; separate real-font case 1 passed | FAIL engine acceptance |
| WebKit 26.6 revision 2359, macOS arm64 | 16 attempted cases: all crash before product page; 1 obsolete diagnostic skip | BLOCKED/FAIL runtime, NOT product pass |
| Chromium | Existing parent complete suite remains its recorded 15 clean + shutdown passes/1 diagnostic skip; no redundant rerun here | Historical PASS at supplied base; unchanged by other-engine failures |
| macOS arm64 packaged Electron 44.9.0 | Fresh sandboxed app/standalone Node/worker. Original smoke rerun failed at undo geometry assertion | FAIL this run; earlier successful smoke remains historical |
| macOS arm64 independent packaged focus/recovery probe | Pointer drawing, composer shortcut isolation, actual lost freeze-ack 503 retaining generation/realm/scene pass; immediate reconnect switch returns 409 | Partial checks PASS; overall FAIL recovery probe |
| macOS x64 / Windows x64 / Linux x64 packaged GUI | No actual target runner execution | NOT RUN |
| OS Chinese IME / native file dialogs, all targets | ABC selected locally; System Events UI elements enabled=false | NOT RUN; human witnessed receipt required |

Firefox failures: select-all/arrow geometry does not move in A06 and both full
production sizes; progressive-preview case fails real shutdown (`view_barrier`);
second-window and CAS cases fail finding the expected tool frame; both A10 sizes
time out waiting for download; aggregate transport and viewport restoration fail.
The latter errors are fully preserved in JSON/logs/traces, not reclassified as
passes. This is **new Firefox evidence**, not a claim that the resolved Chromium
three-shutdown issue is still unimplemented.

Firefox font probe opens the real archive-backed iframe, loads declared FontFace
families with Latin/CJK samples, checks loaded faces/no face errors/actual local
font HTTP 200/no external requests, and passes real shutdown. This demonstrates
font-byte loading, not human judgment of every Chinese glyph or an IME pass.

WebKit launches MiniBrowser then exits with `Segmentation fault: 11` before
`newPage`. Same standalone probe reproduces this. No downloads or lifecycle
behavior in the product was reached. Do not substitute installed Safari for this
result without a separately identified actual run.

Native baseline failed `scene.elements[0].x != moved` after Cmd-Z (200 remained
200). It stopped before the save/export checks; no current-run native dialog or
PNG result is claimed. Independent recovery probe blocks only real browser view
ack HTTP requests with 503 (no fake successful ack). Switch correctly refuses
with 409 and retains exact realm src/generation/scene. Removing the fault then
immediately requesting a real switch still returns 409: reconnect completion is
not certified. Cleanup closes the app and nonce-stops only its owned isolated
backend before deleting the profile; failure exits remain nonzero.

## Available environment and remaining capability

Local host is Darwin arm64. Docker reports Linux **aarch64**, but a container
with no demonstrated native GUI/IME receipt is not a Linux x64 packaged-app
runner, Windows, or macOS Intel. No usable target-native runner or human
interactive receipt was supplied to this issue. No SSH credential/config files
were inspected and no external service permissions changed. Do not cross-build
and label it native execution, enable accessibility silently, use `--no-sandbox`,
re-sign downloaded applications, or inject text/composition as an IME substitute.

## Reproduction

Use a separate worktree at the recorded base and its own npm/node_modules.
Stage the supplied exact tgz on each runner (do not replace it with registry
0.1.0). `npm ci` installs the lockfile. Set:

```sh
export HOSTED_EXCALIDRAW_TGZ=/absolute/path/to/chengzhiyi-pi-excalidraw-0.1.0.tgz
export ORI41_TARGET_OS=darwin # win32 or linux on those actual OSes
export ORI41_TARGET_ARCH=arm64 # x64 on those actual runners
export ORI41_BROWSER=firefox # webkit or chromium, one per job
node scripts/run-hosted-platform-matrix.mjs browser
# Executable must match the freshly prepared/packaged native target:
export PI_WEB_DESKTOP_EXECUTABLE="$PWD/desktop-release/mac-arm64/pi.app/Contents/MacOS/pi"
node scripts/run-hosted-platform-matrix.mjs desktop
```

Use native shell environment syntax on Windows. Runner rejects OS/arch mismatch
before build and validates the exact archive hash. `npm_execpath` may explicitly
point to the installed npm CLI JS if npm is installed outside Node's normal tree.
Logs/JSON retain failures and the strict teardown gate. Wrong-OS negative control
was executed and refused before packaging. New scripts pass `node --check`;
`npm run check` passes. The complete orchestration and foreign-OS branches have
not themselves been run end-to-end; direct commands produced the recorded runs.

`docs/ci/ori41-native-matrix.yml` is an **inert** self-hosted target matrix, not an
installed workflow or dispatched job. Operator must pin approved action SHAs,
provide matching Node/native GUI/signed-runtime prerequisites, and stage the tgz
before any authorized use. The task did not authorize pushing/enabling it.

## Per-platform witnessed checklist (required separately for EACH platform)

Apply all rows to macOS arm64, macOS x64, Windows x64 and Linux x64; nothing
inherits a pass from another OS. Record PASS/FAIL/NOT RUN and evidence for each.

| Item | Required observable action/evidence |
| --- | --- |
| Identity/safety | Actual OS/version/architecture, host+plugin commits, tgz hash, app path/hash, prepare PTY probe, signature integrity where applicable; normal sandbox/CSP/guards unchanged |
| A07 native IME | Select real OS Chinese input method; type pinyin into canvas text, show candidate window, select Chinese, continue composing while attempting send/update; composer retained; no model send before real safe point. Commit composition then verify scene/checkpoint Chinese text; test focus out/back. Screen recording + input-source name; synthetic events/insertText invalid |
| Focus/shortcuts | Canvas vs composer vs app menu: selection, arrow move, undo/redo, save, Escape and focus restoration; verify actual geometry and untouched composer/scene, not just visual UI response |
| A10 source/files | Chinese/space-path save and reopen, SVG and transparent PNG; actual native open/save chooser, cancel, overwrite and focus return. Record dialog screenshots/video, resulting bytes and hashes. Test-selected save destination is not native-dialog acceptance |
| A22 recovery | Disconnect actual transport or inject identified failed HTTP without fake ack; dirty send/update refused, original realm retained, restore connection and explicitly retry; verify exact scene/files/session/PIDs and real flush; never automatic Restore/TTL clearing |
| A23 browser | Exact browser engine+version, iframe authenticated communication, local fonts/no unexpected external requests, downloads and full lifecycle including teardown at wide/narrow widths. Safari result must name Safari, not only WebKit |
| Cleanup | App and owned backend/worker exit; capture failure as well as teardown logs; do not stop shared/external backends |

Receipt must include commands, exit codes, screenshots/recording, bytes/hash
checks and raw logs; redact tokens/credentials, not assertions/failures. A text
"looks good" is insufficient.

## Structured continuation

See `docs/evidence/ori41/continuation.json`. Waiting input is only access to
existing native GUI runners or verifiable per-target receipts and an actual
human IME/dialog session. No credentials in comments, publication approval or
repeated implementation approval requested. Product failures above remain work
on this issue after environment continuation; no A01–A25 blanket pass or `done`.
