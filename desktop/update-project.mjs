import { execFile, spawn } from "node:child_process";
import { constants, readFileSync } from "node:fs";
import { access, copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, rmdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { assertDesktopInstallSafe } from "./update-native.mjs";
import { checkDesktopRelease, downloadDesktopAsset, parseProjectPublicKey } from "./update-release.mjs";
import { localize as t } from "./locale.mjs";

const execute = promisify(execFile);
const bundleName = "pi.app";
const transactionPattern = /^\.pi-update-[a-zA-Z0-9]{6}$/;

export function bundledProjectKey() {
  try {
    const key = readFileSync(new URL("./update-project-key.pem", import.meta.url), "utf8");
    parseProjectPublicKey(key);
    return key;
  } catch { return null; }
}

async function bundleIdentity(path) {
  const info = await lstat(path, { bigint: true });
  if (!info.isDirectory()) throw new Error("Expected a real app directory");
  return [String(info.dev), String(info.ino)];
}

// A thin 64-bit ARM Mach-O, as built by the arm64 release job. Avoid xcrun
// or lipo at runtime: the tester's Mac need not have developer tools installed.
async function isArm64Executable(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const header = Buffer.alloc(16);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    return bytesRead === 16 && header.readUInt32LE(0) === 0xfeedfacf
      && header.readUInt32LE(4) === 0x0100000c && header.readUInt32LE(12) === 2; // MH_EXECUTE
  } finally { await file.close(); }
}

export async function isAdHocApp(appPath, run = execute) {
  try {
    const { stderr } = await run("/usr/bin/codesign", ["-dv", "--verbose=4", appPath], { timeout: 10000 });
    return /^Signature=adhoc$/m.test(stderr) && !/^TeamIdentifier=[A-Z0-9]{10}$/m.test(stderr);
  } catch { return false; }
}

/** Called only after the official prerelease manifest signature and DMG digest
 * are verified. Never evaluate payload code or run an installer from the image. */
export async function stageProjectInstaller({ appPath, dmg, manifest, mount, signal, run = execute }) {
  const installDir = dirname(appPath);
  if (basename(appPath) !== bundleName || await realpath(installDir) !== installDir || !await isAdHocApp(appPath, run)) {
    throw new Error("Not an installed ad-hoc app");
  }
  const old = await bundleIdentity(appPath);
  const transaction = await mkdtemp(join(installDir, ".pi-update-"));
  const candidate = join(transaction, bundleName);
  try {
    // Don't abort hdiutil mid-attach: it can leave a live but unreported mount.
    await mkdir(mount, { mode: 0o700 });
    try {
      await run("/usr/bin/hdiutil", ["attach", "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", mount, dmg], { timeout: 120000 });
      signal?.throwIfAborted();
      const source = join(mount, bundleName);
      await bundleIdentity(source);
      await run("/usr/bin/ditto", ["--qtn", source, candidate], { timeout: 180000 });
    } finally {
      await run("/usr/bin/hdiutil", ["detach", mount], { timeout: 30000 }).catch(() =>
        run("/usr/bin/hdiutil", ["detach", "-force", mount], { timeout: 30000 }));
    }
    signal?.throwIfAborted();
    const plist = join(candidate, "Contents", "Info.plist");
    const property = async name => (await run("/usr/libexec/PlistBuddy", ["-c", `Print :${name}`, plist], { timeout: 10000 })).stdout.trim();
    if (await property("CFBundleIdentifier") !== "dev.pi.webapp" || await property("CFBundleExecutable") !== "pi"
      || await property("CFBundleShortVersionString") !== manifest.version || await property("CFBundleVersion") !== `${manifest.build}.0.0`
      || !await isArm64Executable(join(candidate, "Contents", "MacOS", "pi"))
      || !await isAdHocApp(candidate, run)) throw new Error("DMG app identity does not match its receipt");
    await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", candidate], { timeout: 60000 });
    // Node fetch does not set quarantine. Preserve any existing value, and when
    // missing mark the incoming app as a fresh network download (not approved).
    const { stdout: attrs } = await run("/usr/bin/xattr", [candidate], { timeout: 10000 });
    if (!attrs.split(/\r?\n/).includes("com.apple.quarantine")) {
      await run("/usr/bin/xattr", ["-w", "com.apple.quarantine", `0081;${Math.floor(Date.now() / 1000).toString(16)};pi;`, candidate], { timeout: 10000 });
    }
    signal?.throwIfAborted();
    return { transaction, old, next: await bundleIdentity(candidate), manifest };
  } catch (error) {
    await rm(transaction, { recursive: true, force: true });
    throw error;
  }
}

export function launchProjectSwap(helperPath, appPath, pending, spawnProcess = spawn) {
  const child = spawnProcess(helperPath, [String(process.pid), dirname(appPath), basename(pending.transaction), ...pending.old, ...pending.next],
    { detached: true, stdio: "ignore", cwd: "/", env: {} });
  child.on("error", () => {}); // No swap if launch fails; the old app remains installed.
  child.unref();
}

export class ProjectDesktopUpdate {
  constructor({ current, packaged, platform = process.platform, arch = process.arch, appPath, home,
    profile, cachePath, helperPath, getBackend, showMessageBox, onChange = () => {},
    key = bundledProjectKey(), check = checkDesktopRelease, download = downloadDesktopAsset,
    stage = stageProjectInstaller, launch = launchProjectSwap }) {
    Object.assign(this, { current, appPath, profile, cachePath, helperPath, getBackend, showMessageBox,
      onChange, key, check, download, stage, launch });
    this.optInPath = join(profile, "desktop-project-updates-enabled");
    this.available = Boolean(key && packaged && platform === "darwin" && arch === "arm64" && process.getuid?.() !== 0
      && ["/Applications/pi.app", join(home, "Applications", bundleName)].includes(appPath));
    this.enabled = false;
  }

  async initialize() {
    if (!this.available) return;
    try {
      await access(this.helperPath, constants.X_OK);
      const dir = dirname(this.appPath);
      if (await realpath(dir) !== dir || !await isAdHocApp(this.appPath)) throw new Error("Unsupported install");
    } catch { this.available = false; return; }
    try { this.enabled = (await readFile(this.optInPath, "utf8")) === "enabled\n"; } catch { /* default off */ }
    // Only reveal a backup created by a completed atomic exchange. Never delete
    // or automatically reopen it; macOS may have denied the new app on launch.
    try { this.previous = await findPreviousProjectInstall(this.appPath); } catch { /* manual Finder recovery remains possible */ }
  }

  async setEnabled(enable) {
    if (!this.available || this.changing || this.closing || enable === this.enabled) return;
    this.changing = true;
    try {
      if (enable) {
        const answer = await this.showMessageBox({ type: "warning", noLink: true, defaultId: 0, cancelId: 0,
          message: t("启用测试版桌面自动更新？", "Enable Test Desktop Auto-Updates?"),
          detail: t("后台只下载带项目签名的测试版。正常退出且内置后台已停止时替换应用；不自动重启。新版本未经 Apple 公证，可能需要你在系统设置中手动允许打开。旧版会保留，可用 Finder 恢复。", "Only project-signed test releases are downloaded. The app is replaced on normal exit once the bundled service has stopped; it is not relaunched. Test builds are not notarized by Apple and may require manual approval in System Settings. The previous app is kept for Finder recovery."),
          buttons: [t("取消", "Cancel"), t("启用", "Enable")] });
        if (answer.response !== 1 || this.closing) return;
        await writeFile(this.optInPath, "enabled\n", { mode: 0o600, flag: "wx" });
      } else {
        await rm(this.optInPath, { force: true });
        this.cancelDownload();
      }
      this.enabled = enable;
      if (!enable) await this.discard();
    } finally { this.changing = false; this.onChange(); }
  }

  cancelDownload() { this.controller?.abort(); }

  async discard() {
    const pending = this.pending;
    this.pending = null;
    if (pending) await rm(pending.transaction, { recursive: true, force: true }).catch(() => {});
  }

  run() {
    if (!this.enabled || this.busy || this.closing || this.pending) return;
    return (this.inFlight = this.prepare());
  }

  async prepare() {
    const controller = new AbortController();
    this.controller = controller;
    this.busy = true;
    this.failed = false;
    this.onChange();
    let cache;
    try {
      const manifest = await this.check(this.current, { projectKey: this.key, signal: controller.signal });
      if (!manifest) return;
      cache = await mkdtemp(join(this.cachePath, "pi-project-update-"));
      const dmg = join(cache, manifest.asset.name);
      await this.download(manifest, manifest.asset, dmg, {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15 * 60 * 1000)]),
      });
      controller.signal.throwIfAborted();
      this.preparing = true;
      const pending = await this.stage({ appPath: this.appPath, dmg, manifest, signal: controller.signal, mount: join(cache, "mount") });
      this.pending = pending;
      if (controller.signal.aborted || !this.enabled || this.closing) await this.discard();
    } catch {
      this.failed = !controller.signal.aborted;
    } finally {
      // Remove only the downloaded file. Never recursively remove a directory
      // which could still be a live mount after an OS-level unmount failure.
      if (cache) {
        const files = await readdir(cache, { withFileTypes: true }).catch(() => []);
        for (const file of files) if (file.isFile()) await rm(join(cache, file.name), { force: true }).catch(() => {});
        await rmdir(join(cache, "mount")).catch(() => {});
        await rmdir(cache).catch(() => {});
      }
      this.controller = null;
      this.preparing = false;
      this.busy = false;
      this.onChange();
    }
  }

  /** Never initiate backend shutdown. An ordinary, explicitly confirmed quit
   * already controls whether the user wants to keep their backend running. */
  async prepareQuit() {
    this.closing = true;
    this.cancelDownload();
    // Let hdiutil/ditto finish cleanup if the quit dialog overlapped mounting.
    if (this.preparing) await this.inFlight;
    if (!this.enabled || !this.pending) return;
    try {
      const helper = join(this.pending.transaction, "update-swap");
      // Run the currently trusted helper from outside the installed app, so
      // it neither counts as a live bundle process nor moves with the backup.
      await copyFile(this.helperPath, helper, constants.COPYFILE_EXCL);
      await assertDesktopInstallSafe(this.getBackend());
      this.armed = { pending: this.pending, helper };
    } catch { await this.discard(); }
  }

  // Called only by Electron's will-quit following an ordinary app.quit().
  commitQuit() {
    if (!this.armed) return;
    const { helper, pending } = this.armed;
    this.armed = null;
    try { this.launch(helper, this.appPath, pending); } catch { /* keep the current app */ }
  }
}

async function findPreviousProjectInstall(appPath) {
  const dir = dirname(appPath);
  const found = [];
  for (const name of await readdir(dir)) {
    if (!transactionPattern.test(name)) continue;
    const transaction = join(dir, name);
    const info = await lstat(transaction).catch(() => null);
    if (!info?.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700) continue;
    const result = join(transaction, "result");
    const receipt = await lstat(result).catch(() => null);
    if (!receipt?.isFile() || receipt.size !== 10 || await readFile(result, "utf8").catch(() => null) !== "installed\n") continue;
    const backup = join(transaction, bundleName);
    if ((await lstat(backup).catch(() => null))?.isDirectory()) found.push({ backup, time: receipt.mtimeMs });
  }
  return found.sort((a, b) => b.time - a.time)[0]?.backup;
}
