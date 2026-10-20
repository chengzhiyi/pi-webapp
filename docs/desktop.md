# Desktop application

The desktop application **pi** is an optional Electron host for the existing Web UI.
The `npx pi-webapp` and Pi `/web` entry points remain available. There is no
second implementation of chat, files, terminals, Git or session storage.

## Build and run

Build on the target OS and architecture (macOS/Linux/Windows, x64 or arm64):

```bash
npm ci
npm run check
npm test
npm run desktop:prepare
npm run desktop:start
```

`desktop:prepare` builds the UI/extension, downloads **Node 22.23.3** from
nodejs.org, verifies the archive against the official HTTPS SHA-256 manifest,
and installs the pinned production dependencies from
`desktop/runtime-manifest/package-lock.json`. It verifies the bundled Pi version
and actually starts a PTY before declaring success. Internet is required while
building, not to install Node/Pi on the end user's machine. Model calls,
authorization and package installation can still require internet.

The staging directory is `.desktop/runtime/`:

- `node/`: standalone Node and npm, including their upstream license.
- `backend/`: pi-webapp assets, extension, launcher and locked dependencies,
  including Pi. It is outside ASAR, so Node and native PTY helpers run normally.
- `build-info.json`: app/runtime versions, platform, architecture and Node checksum.

Electron's renderer has no Node integration or preload bridge. It loads the same
loopback HTTP page as a browser, with sandboxing, context isolation, normal CSP,
and the existing bearer-token authentication. External HTTP(S) links require a
native confirmation and open in the default browser. Other OS protocols, webviews,
page-created windows, permission requests and downloads are not enabled.

## Create an installer

```bash
npm run desktop:package             # DMG / NSIS installer / AppImage on this host
npm run desktop:package -- --dir    # unpacked application for QA
```

Output is in `desktop-release/`. The macOS bundle is **pi.app**, the native menu
and window name are **pi**, and installer names include a desktop build number,
e.g. `pi-0.1.19-desktop.4-mac-arm64.dmg`. “pi → 关于 pi” shows the build number
and executable location, so different desktop rebuilds are distinguishable even
when their shared backend stays at the same npm version. `desktop/release.json`
is the single source for the desktop name/build; increment its build number for
each delivered rebuild. The CFBundleVersion / Windows file version also changes.

Cross-platform/architecture flags are
intentionally rejected by the wrapper: using the current machine's Node/native
modules in another platform's installer would create a broken application. Use
native runners for each target. A manual GitHub Actions workflow is provided;
it never publishes a release automatically.

The application embeds Node and Pi. Git, SSH, project compilers and other system
tools are **not** bundled. Missing tools must be installed by the user. Model
accounts/API credentials must still be configured in the existing settings UI.

### Signing and updates / “签名更新”

These are two separate release responsibilities:

- **Code signing** identifies the publisher and protects the application from
  undetected modification. macOS public distribution normally also needs Apple
  notarization. Windows signing reduces unknown-publisher warnings. These require
  the publisher's own credentials/certificates and, potentially, paid accounts.
- **Safe updates** verify an update's publisher/integrity and replace a compatible
  application/runtime without destroying user data.

This first implementation creates **unsigned local/test installers**, with no
certificate discovery, notarization, public release, or automatic desktop updater.
macOS Gatekeeper / Windows SmartScreen may warn or block an unsigned download.
Do not disable OS security globally to use it. Public distribution needs a
separately configured, authorized signing/notarization workflow; local successful
packaging is not proof of public-distribution readiness.

For now, install a newer desktop package to upgrade; if replacing a running
desktop-owned runtime, first finish tasks and stop that owned service. A desktop
attached to an external Web service can simply close without stopping the service. Desktop-managed backends reject the Web/npm update and restart paths,
so the UI cannot overwrite the bundled runtime. A desktop window attached to an
existing npm-managed backend preserves that backend's original update behavior.

### Upgrading from the former “Pi Webapp” app

1. Quit the old desktop process first. A running old instance cannot be replaced
   in memory by dragging a new app into Applications. Keep an external Web
   backend running; an attached desktop's exit never stops it.
2. Open the **new build-numbered** DMG and drag **pi.app** into Applications.
   If pi.app already exists, confirm Replace. The formerly named Pi Webapp.app
   is a separate Finder item and is not silently deleted or overwritten.
3. Explicitly open `/Applications/pi.app`, not the old Dock shortcut, an older
   mounted disk image, or Pi Webapp.app. Verify **pi → 关于 pi → 桌面构建 4**.
4. Remove the old pinned Dock shortcut and pin the new pi.app. Once verified,
   the old Pi Webapp.app may be removed manually; do not delete `~/.pi`.

The bundle ID remains `dev.pi.webapp`. The old Electron profile/instance-lock
location (`appData/Pi Webapp`) is retained so the rename does not reset UI
preferences or allow a second independent desktop instance. Explicit
`--user-data-dir` overrides are respected for testing. Pi configuration and
sessions still live in their existing directory. The shared Web document/CLI
keeps its existing name; this rename is for the native desktop application.

## Application icon

The desktop uses an original deep-teal rounded tile with an ivory **π** monogram
and a mint **>_** terminal prompt. Editable artwork lives in
`desktop/icons/icon.svg`; the checked-in `icon.png` (1024px, transparent),
`icon.icns` (standard/Retina macOS sizes), and `icon.ico` (16–256px Windows sizes)
are generated from it. Packaging explicitly selects an icon for each platform;
the window and macOS development Dock also use this artwork instead of Electron's.

To regenerate after editing the SVG:

```bash
npx playwright install chromium   # only needed to regenerate artwork
npm run desktop:icons
# Or use installed Google Chrome: PI_WEB_TEST_CHROME=true npm run desktop:icons
npm run test:desktop
npm run desktop:package
```

Normal packaging uses the committed images and does not need a browser or an
image-conversion dependency. Installing a rebuilt app replaces its icon; quit
the old app first and replace it in Applications. A stale pinned Dock shortcut
may need to be removed and re-added. Do not modify an installed application's
bundle to change its icon, and do not delete Pi user data to refresh an icon.

## Service ownership and shared state

The existing launcher state directory and exclusive lock are reused under
`~/.pi/agent/pi-web/` (or `PI_CODING_AGENT_DIR`). Model credentials and Pi sessions
stay in Pi's existing data directory, not inside the application bundle.

- The desktop checks a live launcher's bridge version, exact app version, token
  and authenticated version endpoint before attaching. The released **0.1.19**
  Web launcher predates these metadata fields: when they are absent, the desktop
  also checks the authenticated session schema (v1) and the initial NDJSON
  snapshot event before attaching. This is a narrow, tested legacy allowlist,
  not cross-version compatibility or unconditional acceptance of missing fields.
- Legacy detection uses only GET requests, cancels its temporary event stream,
  bounds response size/time, and never rewrites launcher state or claims service
  ownership. A service replaced during a handshake is rechecked.
- Explicit incompatible protocols/versions, bad authentication, and failed health
  checks remain errors with distinct messages. A native dialog offers retry,
  opening the authenticated existing service in a browser when safe, or exiting.
  It never stops, upgrades, or migrates an external service automatically. A truly
  incompatible backend must be switched from its original entry point after
  finishing tasks; a compatible old Web backend does **not** need to be stopped.
- If there is no running service, the desktop starts the shared launcher with its
  bundled Node/Pi. A racing launcher still has to acquire the same exclusive lock.
- A desktop application is single-instance. Launching it again focuses its window.
- Closing the window or choosing Quit asks whether to stop the owned service or
  leave it running. Stopping ends **all** sessions and terminals on that service,
  including those used by a browser. Cancel leaves the application open.
- An attached service is never stopped by closing the desktop window.
- “Window → Open in browser” opens the same backend, not another Pi process.
- After choosing to leave the service running, reopening the desktop attaches to
  it. To stop it later, use the Web launcher's `pi-webapp stop` command (or
  `npm run stop` from this checkout); a new attached desktop does not claim ownership.

The initial workspace is the user's home directory; add/select project workspaces
using the existing UI. No shell login scripts are executed merely to construct a
PATH. The bundled Node directory is prepended to the GUI process's environment;
Git/SSH/toolchain PATH differences on desktop launch should be checked explicitly.

## Tests

```bash
npm run test:desktop
npm run desktop:smoke
npm run desktop:smoke -- --packaged
# Reproduce the original bug against an installed, pre-desktop 0.1.19 npm release:
npm run desktop:smoke:legacy -- --packaged --legacy-package /path/to/node_modules/pi-webapp
```

Smoke testing requires a graphical session (Linux can use Xvfb) and Playwright
Chromium (`npx playwright install chromium`). Set `PI_WEB_TEST_CHROME=true` to
use an installed Chrome instead. Build the unpacked application before the
`--packaged` test. The smoke test uses a temporary HOME/Pi directory and a PATH
without global Node/Pi. It tests renderer isolation, real PTY interaction,
authentication, file listing, desktop update protection, a browser connected to
the same service, and confirmed shutdown/process cleanup. It does **not** submit
a paid model request, log in to a provider, or use the user's saved credentials.
Screenshots/results are written to `artifacts/desktop/`.

The legacy smoke uses a temporary HOME/agent directory and copies the old package
without changing its launcher or extension JavaScript. It prepares node-pty's
macOS helper executable bit **only in its fixture copy** (as normal installation
would), leaving the original installed release and live service untouched. It
starts the genuine old Web backend first, opens a working browser PTY, attaches
the desktop to the same chat, and verifies that the same PTY and backend survive
both attachment and desktop exit. The complementary regular smoke covers the
opposite order: desktop first, then browser. No model request is sent.

If the local harness wraps Git with a forced author, the existing Git history test
may observe that author instead of its fixture author. Run tests with the normal
system Git in PATH in an isolated test environment; do not change global Git
configuration to make a fixture pass.

## Updating runtime dependencies

When production dependencies or pinned Pi versions in the root manifest change:

```bash
npm run desktop:sync-runtime
# Review and commit desktop/runtime-manifest/package{,-lock}.json.
npm run desktop:prepare
```

The sync command seeds resolutions from the main lockfile and generates a separate
production-only lockfile. Preparation refuses to proceed when these dependencies
are out of sync. Electron and electron-builder are development dependencies only;
they do not enter the published npm package's runtime dependencies.

## Verification scope of the initial delivery

macOS arm64 is the local implementation/QA target. Windows/Linux installer
configuration is provided but must be tested on their own runners before promising
support. Custom icons are configured for all platforms; the icon replacement
has only been verified in a packaged macOS arm64 app.
Formal signing, automatic desktop updates, tray integration, completion
notifications and cross-platform end-to-end QA are not included in this delivery.
