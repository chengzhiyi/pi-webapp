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
e.g. `pi-0.1.20-desktop.5-mac-arm64.dmg`. “pi → 关于 pi” shows the build number
and executable location, so different desktop rebuilds are distinguishable even
when their shared backend stays at the same npm version. `desktop/release.json`
is the single source for the desktop name/build; increment its build number for
each delivered rebuild. The CFBundleVersion / Windows file version also changes.

Cross-platform/architecture flags are
intentionally rejected by the wrapper: using the current machine's Node/native
modules in another platform's installer would create a broken application. Use
native runners for each target. `desktop.yml` remains a manual cross-platform
packaging/artifact workflow. The separate `desktop-release.yml` below handles
verified macOS arm64 prereleases, not every main push.

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

Starting with desktop build 7, default macOS packages use **complete ad-hoc
signatures, without publisher identity or notarization**, for opt-in small-group
testing. No certificate is needed: `mac.identity` defaults to `-`. Electron-builder
signs nested code before creating DMG/ZIP; both packaging and release preparation
reject failed deep/strict verification or a missing resource seal. Certificate
discovery stays disabled. Windows/Linux defaults are unchanged.

**Ad-hoc is not Developer ID.** Gatekeeper can still block the download; a GitHub
prerelease and a valid resource seal do not prove publisher identity or safety.
Follow the [tester installation and trust instructions](desktop-testing.md),
including checksum verification, stopping on signature failure, and a manual,
app-scoped trust exception only for a known, trusted test build. Do not disable
OS security globally. Public distribution needs a separately configured,
authorized signing/notarization workflow; local packaging/smoke success is not
proof of downloaded first-launch acceptance.

Use **pi → 检查桌面更新…** (also available in the connection-recovery dialog).
The native app checks the latest 100 official GitHub Releases, including the
explicitly labeled test prereleases; npm's `latest` does not drive desktop updates.
Checks also run once after a successful desktop connection (set
`PI_WEBAPP_DESKTOP_UPDATE_CHECK=manual` to use menu-only checks, as smoke QA does).
Nothing is downloaded
or installed without consent. Versions compare backend version, then desktop build.
Older versions/builds and drafts are never selected.

- Downloads are streamed into private temporary directories, limited to 2 GiB and
  15 minutes, and verified against the release's exact byte count and SHA-256.
  Only the fixed publisher's HTTPS GitHub URLs and GitHub release-asset redirects
  are accepted; no backend/renderer-supplied update URL or privileged IPC is used.
  Download progress appears on the main window's OS progress indicator. Use
  **pi → 取消桌面更新下载** to abort; partial downloads are removed.
- **Unsigned current app or release / old manifest without a ZIP:** download and
  verify the DMG, reveal it in Finder, and install manually. A checksum over HTTPS
  is not a code signature; unsigned packages are never silently executed or
  automatically installed. Checked DMGs remain in the temporary directory for
  the manual handoff (the OS may eventually clean them).
- **Publisher-signed current app and target ZIP:** after SHA-256 verification,
  a separate **安装并重启** confirmation and backend safety check are required
  **before** handing anything to Squirrel.Mac. Its native updater then verifies
  the target against the installed app's signing identity and stages replacement.
  Squirrel may apply a staged update on normal exit too, so deferring installation
  keeps only the ZIP, not a native-pending update. The backend is checked again
  before installation/normal exit once native staging has completed.
  A random-token loopback feed serves only the already
  checked ZIP, closes after staging, and is never exposed to the shared Web page.
  Failed staging leaves the original app untouched. Atomic replacement/relaunch
  and install-failure recovery are delegated to Squirrel.Mac, not a shell script
  that rewrites `.app`. A native staging failure/timeout requires restarting the
  desktop before another native attempt; download/check failures may be retried.
- **Live bundled runtime (owned or attached) or unknown/starting backend:** install
  is deferred. Finish **all** browser/desktop tasks and terminal operations, then
  stop the bundled service from its original entry point (`pi-webapp stop`). Keep
  the desktop open and choose the update menu again to install the staged update.
  The updater itself never stops a service, guesses whether a terminal is idle,
  or writes launcher/update/restart metadata. Live authenticated external npm
  backends remain running and are rechecked for replacement before installation.
  If the backend changed versions, reopening may still require browser recovery:
  desktop updates do not imply arbitrary cross-version protocol compatibility.

The old desktop without this updater still needs a one-time manual installation.
This feature does not modify an already installed app merely by editing source.
Current unsigned test releases exercise the manual-download branch; actual native
replacement needs signed old/new applications and a separate signed release QA.
Use an authorized Developer ID signing setup with `desktop:package` to produce
signed DMG/ZIP pairs (the wrapper disables discovery, so the release operator must
explicitly select their configured identity with `CSC_NAME`); do not enable certificate discovery or publish merely to
try this feature. Release preparation checks the actual app's deep/strict code
signature and TeamIdentifier, rather than trusting an environment flag. The
manifest records `signing: { type: "ad-hoc" | "developer-id", verified: true }`.
Its compatibility field `unsigned: true` means **no publisher identity**, and
remains true for ad-hoc packages so they never enable native auto-installation.
The manifest does not claim notarization; public signing/notarization remains a
separately authorized release responsibility. Windows/Linux/Intel macOS automatic
installation is not implemented; their native menu opens official Releases.

Desktop-managed backends reject the Web/npm update and restart paths,
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
   mounted disk image, or Pi Webapp.app. Verify the expected build in **pi → 关于 pi**.
4. Remove the old pinned Dock shortcut and pin the new pi.app. Once verified,
   the old Pi Webapp.app may be removed manually; do not delete `~/.pi`.

The bundle ID remains `dev.pi.webapp`. The old Electron profile/instance-lock
location (`appData/Pi Webapp`) is retained so the rename does not reset UI
preferences or allow a second independent desktop instance. Explicit
`--user-data-dir` overrides are respected for testing. Pi configuration and
sessions still live in their existing directory. The shared Web document/CLI
keeps its existing name; this rename is for the native desktop application.

## GitHub desktop prereleases

Download builds from **[GitHub Releases](https://github.com/chengzhiyi/pi-webapp/releases)**,
not the npm package, source ZIP or an expired Actions artifact. The current
release channel only offers tested macOS Apple Silicon DMGs; Windows/Linux and
Intel macOS need their own acceptance before becoming release targets.

`.github/workflows/desktop-release.yml` supports:

- **Tag push**: `desktop-v<backend-version>-b<desktop-build>`, such as
  `desktop-v0.1.20-b5`. The tag must match package.json and desktop/release.json
  at that exact source commit; mismatches fail before installation/build.
- **Manual build only** (default): `gh workflow run desktop-release.yml --ref main`.
  This produces checksummed Actions artifacts without a public release.
- **Explicit manual publication**: add `-f publish=true`. The workflow pins the
  dispatch commit, derives the tag from it, and only creates a missing tag at
  that same commit. Existing tags pointing elsewhere are never moved.

For repeatable publication, commit the intended version/build and push a tag
pointing to that verified source SHA; do not silently follow a moving main while
its independent npm pipeline may write another version. Increment the desktop
build number for each delivered rebuild. Tag creation/release is an intentional
publication action, not part of an ordinary main commit.

The build job uses standard `macos-15` arm64, pinned npm lockfiles, standalone
Node/Pi preparation, icon/config tests and the **packaged** desktop/browser/PTY
smoke. Sentry reporting and certificate discovery are disabled; macOS ad-hoc
signing and strict integrity checks are required. It produces:

- `pi-<version>-desktop.<build>-mac-arm64.dmg` (manual installation)
- `pi-<version>-desktop.<build>-mac-arm64.zip` (native updater archive)
- `SHA256SUMS` (DMG and ZIP SHA-256)
- `desktop-release.json` (source SHA, backend/build/runtime versions, actual signing
  status, platform/architecture, DMG/ZIP sizes/checksums and smoke checks)
- `release-notes.md` (used as the Release body, not a separate download asset)

A separate Ubuntu job has scoped `contents: write` and no npm installation/app
execution. It revalidates the source-bound files, creates a **draft prerelease**,
uploads only the four intended assets, downloads them to verify their bytes,
and only then publishes the prerelease with `latest=false`. Ad-hoc integrity is
recorded, but publisher identity and notarization are not claimed. An interrupted upload leaves a draft; retrying the same source/tag may
repair a draft. A published release is never clobbered: a retry only succeeds
when downloaded assets are byte-identical. A conflicting source/tag or different
published bytes fails rather than replacing a public download.

The packing wrapper deliberately retains `--publish never`: explicit CI Release
upload owns publication. The manual cross-platform package workflow remains
artifact-only. npm/Web publishing is unchanged and independent.

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
Formal signing/notarization, actual signed old-to-new installation acceptance,
tray integration, completion notifications and cross-platform end-to-end QA are
not claimed by the ad-hoc test build. The desktop updater's feed, hash verification,
consent, task protection and native-stage success/failure paths have regression
tests; these do not substitute for signed installer acceptance on macOS.
