import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fingerprint, type HostedPairTransaction } from "./hosted-pair.ts";
import { promisify } from "node:util";
import { npmCommand } from "../../../../bin/npm-command.mjs";
import { desktopProtocolVersion, readDesktopRelease, validateDesktopRelease, writeDesktopRelease } from "../../../../desktop/managed-release.mjs";
import { desktopPeerSpecs, verifyDesktopPackage } from "./desktop-package.ts";

const execFileAsync = promisify(execFile);
import { compareVersions, isStableVersion, isAlphaVersion, parseVersion } from "../../../../desktop/release-version.mjs";
export { compareVersions } from "../../../../desktop/release-version.mjs";

import type { UpdateChannel, UpdateRequest, UpdateStatus } from "../../../contracts/bridge-contract.ts";
export type { UpdateStatus } from "../../../contracts/bridge-contract.ts";
export interface PreparedUpdate { version: string; launcher: string }

function dataVersion(pkg: { piWebappDataVersion?: unknown }): number {
  // Releases predating this contract use data format 1 (no app-owned migrations).
  const version = pkg.piWebappDataVersion ?? 1;
  if (!Number.isSafeInteger(version) || Number(version) < 1) throw new Error("应用数据格式版本无效");
  return Number(version);
}

async function npm(args: string[]): Promise<string> {
  try {
    const command = npmCommand(args);
    const { stdout } = await execFileAsync(command.file, command.args, { timeout: 180_000, maxBuffer: 1024 * 1024, encoding: "utf8", windowsHide: true });
    return stdout;
  } catch (error) {
    const detail = error as Error & { stderr?: string };
    throw new Error(detail.stderr?.trim() || detail.message);
  }
}

export class SelfUpdater {
  private readonly agentDir: string;
  private readonly packageRoot: string;
  private readonly launcherNonce: string | undefined;
  private readonly runNpm: (args: string[]) => Promise<string>;
  private readonly desktopManaged: boolean;
  private readonly desktopPackageUpdates: boolean;
  private readonly desktopReleaseChannels: boolean;
  private readonly peerSpecs: typeof desktopPeerSpecs;
  private readonly verifyPackage: typeof verifyDesktopPackage;
  private readonly validateHostedPair?: (version: string, packageRoot: string) => Promise<void>;
  private readonly hostedPair?: HostedPairTransaction;
  private preparing = false;
  private savingPreference = false;
  private restartPending = false;
  private preparedUpdate?: { update: PreparedUpdate; channel: UpdateChannel };
  private readonly beforeRestart?: () => Promise<void>;

  constructor(options: { agentDir: string; packageRoot: string; launcherNonce?: string; runNpm?: (args: string[]) => Promise<string>; desktopManaged?: boolean;
    desktopPackageUpdates?: boolean; desktopReleaseChannels?: boolean; peerSpecs?: typeof desktopPeerSpecs; verifyPackage?: typeof verifyDesktopPackage;
    validateHostedPair?: (version: string, packageRoot: string) => Promise<void>; hostedPair?: HostedPairTransaction;
    /** Drain hosted workers/views while authenticated HTTP is still available, before launcher EOF. */
    beforeRestart?: () => Promise<void> }) {
    this.agentDir = options.agentDir;
    this.packageRoot = options.packageRoot;
    this.launcherNonce = options.launcherNonce;
    this.runNpm = options.runNpm ?? npm;
    this.desktopManaged = options.desktopManaged ?? process.env.PI_WEBAPP_RUNTIME === "desktop";
    // Old shells retain their protection until upgraded once to a capable shell.
    this.desktopPackageUpdates = options.desktopPackageUpdates ?? process.env.PI_WEBAPP_DESKTOP_PACKAGE_UPDATES === "1";
    this.desktopReleaseChannels = options.desktopReleaseChannels ?? process.env.PI_WEBAPP_DESKTOP_RELEASE_CHANNELS === "1";
    this.peerSpecs = options.peerSpecs ?? desktopPeerSpecs;
    this.verifyPackage = options.verifyPackage ?? verifyDesktopPackage;
    this.validateHostedPair = options.validateHostedPair;
    this.hostedPair = options.hostedPair;
    this.beforeRestart = options.beforeRestart;
  }

  private async current(): Promise<string> {
    const pkg = JSON.parse(await readFile(join(this.packageRoot, "package.json"), "utf8"));
    if (pkg.name !== "pi-webapp") throw new Error("当前 pi-webapp 版本无效");
    parseVersion(pkg.version);
    return pkg.version;
  }

  async runningVersion(): Promise<string> { return this.current(); }

  private get preferencePath(): string { return join(this.agentDir, "pi-web", "update-preferences.json"); }

  private async channel(): Promise<UpdateChannel> {
    try {
      const preference = JSON.parse(await readFile(this.preferencePath, "utf8"));
      return preference.channel === "alpha" ? "alpha" : "stable";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "stable";
      throw new Error("无法读取更新偏好，请检查 update-preferences.json");
    }
  }

  async setChannel(channel: UpdateChannel): Promise<{ channel: UpdateChannel }> {
    if (channel !== "stable" && channel !== "alpha") throw new Error("更新通道无效");
    if (this.preparing || this.restartPending || this.savingPreference) throw new Error("升级或偏好保存正在进行中");
    this.savingPreference = true;
    const temporary = `${this.preferencePath}.${randomUUID()}.tmp`;
    try {
      await mkdir(join(this.agentDir, "pi-web"), { recursive: true });
      await writeFile(temporary, JSON.stringify({ channel }), { mode: 0o600 });
      await rename(temporary, this.preferencePath);
    } finally { this.savingPreference = false; await rm(temporary, { force: true }); }
    return { channel };
  }

  async check(): Promise<UpdateStatus> {
    const current = await this.current();
    const channel = await this.channel();
    if (this.desktopManaged && !this.desktopPackageUpdates) return { current, channel, latest: null, available: false, canRestart: false,
      reason: "当前桌面外壳尚不支持业务包在线更新，请先安装新版桌面应用。" };
    if (this.desktopManaged && channel === "alpha" && !this.desktopReleaseChannels) return { current, channel, latest: null, available: false, canRestart: false,
      reason: "当前桌面外壳尚不支持体验版持久化，请先安装支持更新通道的新版桌面应用。" };
    const sourceCheckout = existsSync(join(this.packageRoot, ".git"));
    const status: UpdateStatus = { current, channel, latest: null, available: false, canRestart: Boolean(this.launcherNonce) && !sourceCheckout };
    if (sourceCheckout) status.reason = "当前从源码目录运行。网页升级仅支持 npm 安装的版本，以免覆盖本地代码。";
    else if (!status.canRestart) status.reason = "当前页面由 Pi 终端打开，无法从网页自动重启 Pi；请使用 pi-webapp 启动器。";
    if (this.desktopManaged && this.desktopPackageUpdates) {
      status.desktopShell = { version: process.env.PI_WEBAPP_DESKTOP_VERSION ?? "unknown", build: process.env.PI_WEBAPP_DESKTOP_BUILD ?? "unknown" };
      if (status.canRestart) status.reason = "业务包更新安装到用户目录，不修改 pi.app。请先结束所有聊天任务并关闭终端，再升级并重启后台。";
    }
    try {
      const result: unknown = JSON.parse((await this.runNpm(["view", "pi-webapp", channel === "alpha" ? "dist-tags" : "dist-tags.latest", "--json", "--prefer-online"])).trim());
      // npm 12 wraps scalar/object JSON results in an array.
      const value = Array.isArray(result) && result.length === 1 ? result[0] : result;
      const tags: Record<string, unknown> | null = channel === "alpha" ? value as Record<string, unknown> | null : { latest: value };
      if (!tags || !isStableVersion(tags.latest)) throw new Error("npm 返回的版本号无效");
      let latest = tags.latest;
      if (channel === "alpha" && tags.alpha !== undefined) {
        if (!isAlphaVersion(tags.alpha)) throw new Error("npm 返回的 alpha 版本号无效");
        if (compareVersions(tags.alpha, latest) > 0) latest = tags.alpha;
      }
      status.latest = latest;
      status.downgrade = compareVersions(latest, current) < 0;
      // A channel switch may intentionally select an older stable release.
      // Downgrades are actionable, never automatic, and require prepare() consent.
      status.available = channel === "stable" ? compareVersions(latest, current) !== 0 : compareVersions(latest, current) > 0;
      if (this.desktopManaged && status.downgrade && !this.desktopReleaseChannels && compareVersions(latest, process.env.PI_WEBAPP_DESKTOP_VERSION ?? current) < 0) {
        status.canRestart = false;
        status.reason = "当前桌面外壳尚不支持切回低于内置包的版本，请先安装支持更新通道的新版桌面应用。";
      }
    } catch (error) {
      throw new Error(`检查 npm 更新失败：${error instanceof Error ? error.message : String(error)}`);
    }
    return status;
  }

  async prepare(request?: UpdateRequest): Promise<PreparedUpdate> {
    if (this.desktopManaged && !this.desktopPackageUpdates) throw new Error("当前桌面应用不支持业务包在线更新，请先安装新版桌面应用");
    if (!this.launcherNonce) throw new Error("当前页面无法自动重启 Pi");
    if (existsSync(join(this.packageRoot, ".git"))) throw new Error("源码目录不能通过网页升级");
    if (this.restartPending) throw new Error("升级已完成，正在重启");
    if (this.preparing || this.savingPreference) throw new Error("升级或偏好保存正在进行中");
    // A refused flush leaves the selected pair intact. Retry that exact selection,
    // not a second download/select transaction blocked by our own pending journal.
    if (this.preparedUpdate) {
      if (request && (request.version !== this.preparedUpdate.update.version || request.channel !== this.preparedUpdate.channel)) throw new Error("已有待重启的更新，请先重试该版本或重启后台");
      this.restartPending = true;
      return { ...this.preparedUpdate.update };
    }
    this.preparing = true;
    try {
      const status = await this.check();
      if (request && (request.channel !== status.channel || request.version !== status.latest)) throw new Error("更新目标或偏好已变化，请重新检查更新");
      if (!status.canRestart) throw new Error(status.reason ?? "当前运行方式不支持更新");
      if (!status.available || !status.latest) throw new Error("当前已是最新版本");
      if (status.downgrade && (request?.allowDowngrade !== true || request.channel !== "stable")) throw new Error("切回较低版本需明确确认，请在设置中选择稳定版后重试");
      const releases = join(this.agentDir, "pi-web", "releases");
      await mkdir(releases, { recursive: true });
      // Never delete a potentially live installation selected by another process.
      const releaseDir = await mkdtemp(join(await realpath(releases), `${status.latest}-`));
      let selectionAttempted = false;
      try {
        const peers = this.desktopManaged ? await this.peerSpecs(this.packageRoot) : [];
        await this.runNpm(["install", `pi-webapp@${status.latest}`, ...peers, "--prefix", releaseDir, "--ignore-scripts", "--no-save", "--no-audit", "--no-fund", ...(this.desktopManaged ? ["--engine-strict"] : [])]);
        const installed = join(releaseDir, "node_modules", "pi-webapp");
        const pkg = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
        if (pkg.name !== "pi-webapp" || pkg.version !== status.latest) throw new Error("下载的包与目标版本不符");
        const currentPackage = JSON.parse(await readFile(join(this.packageRoot, "package.json"), "utf8"));
        if (status.downgrade && dataVersion(pkg) !== dataVersion(currentPackage)) throw new Error("数据格式不兼容，不能直接切回旧版。请先备份并按恢复指南操作。");
        const launcher = join(installed, "bin", "pi-webapp.mjs");
        await Promise.all([launcher, join(installed, "dist", "extension.js"), join(installed, "web", "dist", "index.html")].map((path) => access(path)));
        // Both npm launcher and desktop-package selection use the same precommit gate.
        await this.validateHostedPair?.(status.latest, installed);
        const desktopSelection = this.desktopManaged ? await validateDesktopRelease(this.agentDir, { version: status.latest, launcher, desktopProtocolVersion }) : null;
        if (this.desktopManaged) await this.verifyPackage(this.packageRoot, installed);
        const writeSelection = async () => {
          selectionAttempted = true;
          if (this.desktopManaged) {
            const selected = desktopSelection!;
            const saved = await readDesktopRelease(this.agentDir, status.current);
            const previous = saved?.version === status.current ? saved : null;
            const fallbackVersion = process.env.PI_WEBAPP_DESKTOP_VERSION ?? saved?.fallbackVersion ?? status.current;
            await writeDesktopRelease(this.agentDir, { ...selected, ...((status.downgrade || saved?.fallbackVersion) ? { fallbackVersion } : {}), ...(previous ? { previous } : {}) });
          } else {
            const stateDir = join(this.agentDir, "pi-web");
            const temporary = join(stateDir, `update.${randomUUID()}.tmp`);
            try {
              let saved;
              try { saved = JSON.parse(await readFile(join(stateDir, "update.json"), "utf8")); } catch { /* First managed release. */ }
              const baseVersion = saved?.baseVersion ?? status.current;
              const previous = saved?.version === status.current ? saved : undefined;
              // Keep only one rollback entry, never a recursively growing chain.
              if (previous) delete previous.previous;
              await writeFile(temporary, JSON.stringify({ version: status.latest, launcher, baseVersion, ...((status.downgrade || saved?.allowDowngrade === true) ? { allowDowngrade: true } : {}), ...(previous ? { previous } : {}) }), { mode: 0o600 });
              await rename(temporary, join(stateDir, "update.json"));
            } finally { await rm(temporary, { force: true }); }
          }
          const path = join(this.agentDir, "pi-web", this.desktopManaged ? "desktop-update.json" : "update.json");
          return { path, digest: fingerprint((await readFile(path)).toString("base64")) };
        };
        if (this.hostedPair) await this.hostedPair.select(status.latest, installed, writeSelection);
        else await writeSelection();
        this.restartPending = true;
        this.preparedUpdate = { update: { version: status.latest, launcher }, channel: status.channel ?? "stable" };
        return { version: status.latest, launcher };
      } catch (error) {
        // A failed write can be an acknowledged-on-disk rename. Retain potentially selected
        // code and journal for recovery rather than leaving a dangling launcher pointer.
        if (!selectionAttempted) await rm(releaseDir, { recursive: true, force: true });
        throw error;
      }
    } finally { this.preparing = false; }
  }

  async requestRestart(prepared: PreparedUpdate): Promise<void> {
    if (this.desktopManaged && !this.desktopPackageUpdates) throw new Error("当前桌面应用不支持业务包在线更新");
    if (!this.launcherNonce) throw new Error("当前页面无法自动重启 Pi");
    try {
      await this.beforeRestart?.();
      // Revalidate the selected bytes/pointers AFTER the potentially long drain.
      const writeRestart = () => writeFile(join(this.agentDir, "pi-web", "launcher.restart"), JSON.stringify({ nonce: this.launcherNonce, launcher: prepared.launcher }), { mode: 0o600 });
      if (this.hostedPair) await this.hostedPair.restart(prepared.version, dirname(dirname(prepared.launcher)), writeRestart);
      else await writeRestart();
    } catch (error) { this.restartPending = false; throw error; }
  }
}
