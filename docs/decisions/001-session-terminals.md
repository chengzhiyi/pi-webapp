# ADR-001: Session-owned interactive terminals

Status: Accepted

Date: 2026-10-17

## Context and decision

The existing `TerminalBlock` renders tool output and has no terminal emulator or PTY. DSH’s terminal UI uses xterm, but its controller depends on DSH’s gateway and subprocess services. Reuse the existing DSH DockKit controls, panel styles, session controllers, bearer authentication, origin checks, and HTTP/NDJSON bridge. Add a small project-owned PTY registry and tab-owned browser model instead of importing a second gateway or adding WebSockets.

Dependencies are pinned: `node-pty` creates a real PTY with shell job control, signals and resizing; `@xterm/xterm` renders and handles input; `@xterm/addon-fit` measures the grid; `@xterm/headless` with `@xterm/addon-serialize` retains a bounded screen and alternate-buffer state for reconnects. Browser terminal code loads only when a terminal tab is visited. Native/CJS modules load lazily beside the extension, including its bundled build. The packaged postinstall script repairs the missing executable bit on node-pty 1.1.0’s macOS prebuilt spawn-helper; source builds may still require a compiler and Python. Installs with lifecycle scripts disabled must run `node scripts/prepare-terminal.mjs` on macOS.

## Ownership and protocol

Each Dock tab owns a random terminal ID and browser model. Moving a tab, hiding it, collapsing the sidebar, or selecting another chat preserves its model, output connection and process. A controller subscription disposes the model when the tab actually disappears; component unmount only detaches its DOM. The browser serializes input/resize requests, bounds pending input and binds requests to the current connection lifetime. Uncertain input is never retried. Offline events disable input; reconnect restores a serialized server screen without spawning another process. Local layout measurements own the live grid, so delayed resize echoes cannot oscillate the browser dimensions.

All `/api/terminal/*` endpoints are JSON POSTs through the existing bridge. Bodies contain `sessionId` and `id`; `create` and `resize` also contain integer `cols` (2–500) and `rows` (1–300), and `input` contains UTF-8 text `data` (at most 16 KiB). `create` is idempotent for an owned ID. `attach` returns NDJSON `snapshot`, `output`, `resize`, and `exit` frames. `close` is idempotent and verifies the instance’s session ownership even after the active chat changes. Other operations require the current session. Shell and initial cwd come from the server environment and session snapshot; clients cannot provide either.

## Security and resource bounds

Authentication and same-origin validation run before any terminal operation. The listener remains on loopback. Terminal contents are never sent to telemetry. Restart credentials are removed from the shell environment. The shell runs as the Pi user; its initial workspace directory is not a filesystem sandbox.

xterm generates stylesheet elements and truecolor cell style attributes. The bridge gives each HTML response a fresh style nonce. A synchronous adapter applies it to xterm’s styles during `open()` and immediately restores `document.createElement`. Only style attributes allow inline styling; stylesheet elements still require the nonce or same-origin source, and scripts remain same-origin only. Existing bundled data fonts are explicitly permitted. Browser tests assert the script policy, nonce freshness, actual terminal fonts/whitespace, and absence of unexpected console errors.

The registry permits 8 terminals per session and 32 in total, with 2,000 scrollback rows per terminal. PTY reads pause while the headless emulator processes output. Slow HTTP followers disconnect after exceeding a 1 MiB outgoing queue and can reconnect from a screen snapshot. No follower for five minutes triggers process cleanup; session switches normally retain their followers. Explicit close and bridge shutdown kill the shell and discoverable descendants and wait for native PTY settlement. Windows uses `taskkill /T /F`; POSIX inspects process ancestry before termination. Independently daemonized/reparented processes are outside this ownership boundary.

## Validation and limitations

Node integration tests use real shells for cwd, input/output, resize, Ctrl+C, detached output restoration, normal exit, explicit close, service shutdown, retention expiry and limits. HTTP tests cover authentication, origin, session/instance isolation, malformed requests, failed startup, and CSP. Chromium tests cover desktop/mobile widths, file previews alongside terminals, session switches with PID/environment checks, offline reconnect without another create, fullscreen, split, exit and close.

Tabs reset on page reload. A refreshed or closed browser leaves disconnected processes for the five-minute grace period; there is no persisted terminal inventory or recovery across service restarts. The current release uses the default shell without a shell picker. Automated runtime coverage is macOS/Chromium; Windows and Linux code paths require native platform validation.
