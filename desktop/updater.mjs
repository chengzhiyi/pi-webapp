import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { checkDesktopRelease, downloadDesktopAsset, releasesUrl } from "./update-release.mjs";
import { assertDesktopInstallSafe, hasPublisherSignature, stageNativeUpdate } from "./update-native.mjs";

/** Native-only UI. No privileged IPC/preload is added to the shared Web page. */
export class DesktopUpdater {
  constructor({ current, platform = process.platform, arch = process.arch, packaged, appPath, cachePath,
    autoUpdater, showMessageBox, openExternal, revealFile, getBackend, beforeInstall,
    check = checkDesktopRelease, download = downloadDesktopAsset, signed = hasPublisherSignature, stage = stageNativeUpdate,
    setProgress = () => {} }) {
    Object.assign(this, { current, platform, arch, packaged, appPath, cachePath, autoUpdater, showMessageBox,
      openExternal, revealFile, getBackend, beforeInstall, check, download, signed, stage, setProgress });
    this.busy = false;
    this.ready = null;
    this.nativeAttempted = false;
    this.nativeReady = false;
    this.temporary = null;
    // Electron can emit late errors after a timed-out native attempt. Do not crash.
    autoUpdater.on("error", () => {});
  }

  cancelDownload() { this.downloading?.abort(); }

  async message(options) { return this.showMessageBox({ noLink: true, defaultId: 0, cancelId: 0, ...options }); }

  async assertQuitSafe() {
    if (this.nativeAttempted) await assertDesktopInstallSafe(this.getBackend());
  }

  async install() {
    const answer = await this.message({ type: "question", title: "安装桌面更新",
      message: `桌面 ${this.ready.version} · 构建 ${this.ready.build} 已下载并通过 SHA-256 校验`,
      detail: "确认后系统将验证同一发布者签名，并在退出时安装、重启桌面。外部 npm 后台及任务保持运行；若桌面内置后台仍在运行，将延后安装，不会提交给系统更新器。",
      buttons: ["稍后安装", "安装并重启"] });
    if (answer.response !== 1) return;
    // Squirrel may apply a staged update on normal exit too. Never stage before
    // installation consent or while a live bundled backend is using the app.
    await assertDesktopInstallSafe(this.getBackend());
    if (!this.nativeReady) {
      if (this.nativeAttempted) throw new Error("请重启桌面后重新尝试系统安装");
      this.nativeAttempted = true;
      this.setProgress(2);
      try { await this.stage(this.autoUpdater, this.ready, this.zipPath); this.nativeReady = true; }
      catch (error) { this.ready = null; throw error; }
      finally {
        this.setProgress(-1);
        await rm(this.temporary, { recursive: true, force: true }); this.temporary = null; this.zipPath = null;
      }
    }
    await this.assertQuitSafe();
    const resetQuit = this.beforeInstall();
    try { this.autoUpdater.quitAndInstall(); }
    catch (error) { resetQuit?.(); throw error; }
  }

  async run({ silent = false } = {}) {
    if (this.busy) return;
    this.busy = true;
    let interactive = !silent;
    try {
      if (this.ready) { if (!silent) await this.install(); return; }
      if (this.platform !== "darwin" || this.arch !== "arm64" || !this.packaged) {
        if (silent) return;
        const answer = await this.message({ type: "info", title: "桌面更新", message: "此运行环境暂不支持自动安装",
          detail: "自动安装仅支持已安装、具有发布者签名的 macOS Apple Silicon 桌面。源码运行或其他平台请获取对应安装包。",
          buttons: ["取消", "打开官方 Releases"] });
        if (answer.response === 1) await this.openExternal(releasesUrl);
        return;
      }
      const manifest = await this.check(this.current, { arch: this.arch });
      if (!manifest) {
        if (!silent) await this.message({ type: "info", title: "桌面更新", message: "当前渠道没有更新的桌面安装包",
          detail: `当前 ${this.current.version} · 构建 ${this.current.build}。后台版本变化不等于已发布桌面新版。检查范围为最近 100 个官方 Release（含测试预发布）。`, buttons: ["确定"] });
        return;
      }
      interactive = true;
      const automatic = Boolean(manifest.updateAsset && !manifest.unsigned && await this.signed(this.appPath));
      const answer = await this.message({ type: "info", title: "发现桌面更新",
        message: `pi ${manifest.version} · 桌面构建 ${manifest.build}${manifest.prerelease ? "（测试预发布）" : ""}`,
        detail: `当前 ${this.current.version} · 构建 ${this.current.build}。\n` + (automatic
          ? "将从官方 GitHub 下载，校验 SHA-256，并由系统验证同一发布者签名。完成后仍需确认安装重启。"
          : "此包或当前应用没有可验证的发布者签名，或缺少自动更新归档。可下载并校验 DMG 后手动安装；SHA-256 不是发布者签名，不会绕过 Gatekeeper。"),
        buttons: ["稍后", automatic ? "下载并校验" : "下载校验 DMG（手动安装）", "官方发布页"] });
      if (answer.response === 2) { await this.openExternal(releasesUrl); return; }
      if (answer.response !== 1) return;
      if (automatic && this.nativeAttempted) throw new Error("本次桌面已尝试系统暂存，请重启桌面后重新检查更新");
      // DMGs intentionally remain for a manual handoff; only our own temporary ZIPs are removed.
      if (this.temporary) { await rm(this.temporary, { recursive: true, force: true }); this.temporary = null; }
      const directory = await mkdtemp(join(this.cachePath, "pi-desktop-update-"));
      this.temporary = directory;
      const asset = automatic ? manifest.updateAsset : manifest.asset;
      const file = join(directory, asset.name);
      this.downloading = new AbortController();
      this.setProgress(0);
      try { await this.download(manifest, asset, file, {
        signal: AbortSignal.any([this.downloading.signal, AbortSignal.timeout(15 * 60 * 1000)]),
        onProgress: progress => this.setProgress(progress),
      }); }
      catch (error) { await rm(directory, { recursive: true, force: true }); this.temporary = null; throw error; }
      finally { this.downloading = null; this.setProgress(-1); }
      if (!automatic) {
        this.revealFile(file);
        this.temporary = null; // Keep the checked DMG until the user installs/removes it.
        await this.message({ type: "info", title: "桌面安装包已下载", message: "DMG 的 SHA-256 校验通过，已在 Finder 中显示",
          detail: "这是手动安装，不是自动更新。先完成任务并停止使用该应用包的内置后台，再退出旧桌面并替换应用。外部 npm 后台不必停止。未签名测试包可能被系统拦截；不要全局关闭系统安全保护。", buttons: ["确定"] });
        return;
      }
      this.ready = manifest;
      this.zipPath = file;
      await this.install();
    } catch {
      // Keep network/native errors and signed redirect URLs out of native dialogs.
      const detail = this.ready
        ? "更新已下载，但安装保护检查未通过。请先完成任务，从原入口停止桌面内置后台，保持窗口打开，再通过菜单重试安装。未知后台或正在启动的后台也会阻止安装；外部 npm 后台不会被停止。"
        : "检查、下载或系统签名校验失败，未安装更新。请检查网络和磁盘权限后重试；系统暂存失败需重启桌面后重试。也可前往官方 Releases 手动安装。";
      if (interactive) await this.message({ type: "warning", title: "桌面更新未安装", message: "原应用和后台任务保持不变", detail, buttons: ["确定"] });
    } finally { this.busy = false; }
  }
}
