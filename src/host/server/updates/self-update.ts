import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { quarantineJournal } from "./hosted-pair.ts";
import { atomicJson, readJournal } from "../plugins/hosted/storage.ts";
import { promisify } from "node:util";
import { npmCommand } from "../../../../bin/npm-command.mjs";
import { desktopProtocolVersion, validateDesktopRelease } from "../../../../desktop/managed-release.mjs";
import { readCandidate, readUpgradeTransaction, retireCandidate, writeCandidate } from "../../../../bin/upgrade-transaction.mjs";
import { launcherHandoffProtocol, readHandoff, writeHandoff } from "../../../../desktop/launcher-handoff.mjs";
import { desktopPeerSpecs, exactSdkPeerSpecs, verifyDesktopPackage } from "./desktop-package.ts";
import { pruneReleases } from "./release-prune.ts";

const execFileAsync = promisify(execFile);
import { compareVersions, isStableVersion, isAlphaVersion, parseVersion } from "../../../../desktop/release-version.mjs";
export { compareVersions } from "../../../../desktop/release-version.mjs";

import type { UpdateChannel, UpdateRequest, UpdateStatus } from "../../../contracts/bridge-contract.ts";
export type { UpdateStatus } from "../../../contracts/bridge-contract.ts";
export interface PreparedUpdate { version: string; launcher: string }
/** Host-side record of download/validation work. "selecting"/"selected" are only ever read from
 * releases before 0.1.51: the launcher now owns pointer selection, admission and rollback. */
interface UpdateTransaction {
  schema: 1; id: string; phase: "downloading" | "validating" | "prepared" | "selecting" | "selected" | "restart-requested" | "committed" | "cancelled" | "failed";
  version: string; channel: UpdateChannel; packageRoot?: string;
  selectionPath: string; before?: string | null; selectedDigest?: string; message?: string; ownerNonce?: string;
  legacyRecovery?: boolean;
}
const terminal = (phase: UpdateTransaction["phase"]) => ["committed", "cancelled", "failed"].includes(phase);

function dataVersion(pkg: { piWebappDataVersion?: unknown }): number {
  // Releases predating this contract use data format 1 (no app-owned migrations).
  const version = pkg.piWebappDataVersion ?? 1;
  if (!Number.isSafeInteger(version) || Number(version) < 1) throw new Error("应用数据格式版本无效");
  return Number(version);
}

async function npm(args: string[], signal?: AbortSignal): Promise<string> {
  try {
    const command = npmCommand(args);
    const { stdout } = await execFileAsync(command.file, command.args, { timeout: 180_000, maxBuffer: 1024 * 1024, encoding: "utf8", windowsHide: true, signal });
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
  private readonly runNpm: (args: string[], signal?: AbortSignal) => Promise<string>;
  private readonly desktopManaged: boolean;
  private readonly desktopPackageUpdates: boolean;
  private readonly desktopReleaseChannels: boolean;
  private readonly targetPeerSpecs: (version: string) => Promise<string[]>;
  private readonly verifyPackage: typeof verifyDesktopPackage;
  private readonly pluginWarnings?: (version: string) => Promise<Array<{ pluginId: string; message: string }>>;
  private readonly prefetchPlugins?: (version: string, signal?: AbortSignal) => Promise<void>;
  private preparing = false;
  private preparation?: Promise<PreparedUpdate>;
  private cancellation?: Promise<void>;
  private downloadAbort?: AbortController;
  private savingPreference = false;
  private restartPending = false;
  private preparedUpdate?: { id: string; update: PreparedUpdate; channel: UpdateChannel };
  /** The transaction this process is working on; every other record is history to settle. */
  private ownTransaction?: string;
  private readonly beforeRestart?: (force?: boolean) => Promise<void | (() => Promise<void>)>;

  constructor(options: { agentDir: string; packageRoot: string; launcherNonce?: string; runNpm?: (args: string[], signal?: AbortSignal) => Promise<string>; desktopManaged?: boolean;
    desktopPackageUpdates?: boolean; desktopReleaseChannels?: boolean; peerSpecs?: typeof desktopPeerSpecs; verifyPackage?: typeof verifyDesktopPackage;
    /** Plugins unavailable on a target version. Shown before updating; never a gate. */
    pluginWarnings?: (version: string) => Promise<Array<{ pluginId: string; message: string }>>;
    /** Best-effort download of plugin releases compatible with the target. Failures never reach the update. */
    prefetchPlugins?: (version: string, signal?: AbortSignal) => Promise<void>;
    /** Drain hosted workers/views while authenticated HTTP is still available, before launcher EOF. */
    beforeRestart?: (force?: boolean) => Promise<void | (() => Promise<void>)> }) {
    this.agentDir = options.agentDir;
    this.packageRoot = options.packageRoot;
    this.launcherNonce = options.launcherNonce;
    this.runNpm = options.runNpm ?? npm;
    this.desktopManaged = options.desktopManaged ?? process.env.PI_WEBAPP_RUNTIME === "desktop";
    // Old shells retain their protection until upgraded once to a capable shell.
    this.desktopPackageUpdates = options.desktopPackageUpdates ?? process.env.PI_WEBAPP_DESKTOP_PACKAGE_UPDATES === "1";
    this.desktopReleaseChannels = options.desktopReleaseChannels ?? process.env.PI_WEBAPP_DESKTOP_RELEASE_CHANNELS === "1";
    this.targetPeerSpecs = options.peerSpecs ? async () => options.peerSpecs!(this.packageRoot) : async version => {
      const output = (await this.runNpm(["view", `pi-webapp@${version}`, "peerDependencies", "--json", "--prefer-online"], this.downloadAbort?.signal)).trim();
      // Releases predating the declared SDK contract retain the verified local pair.
      if (!output) return desktopPeerSpecs(this.packageRoot);
      const parsed: unknown = JSON.parse(output), value = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed;
      return exactSdkPeerSpecs(value);
    };
    this.verifyPackage = options.verifyPackage ?? verifyDesktopPackage;
    this.pluginWarnings = options.pluginWarnings;
    this.prefetchPlugins = options.prefetchPlugins;
    this.beforeRestart = options.beforeRestart;
  }

  launcherIdentity() {
    return { version: process.env.PI_WEBAPP_LAUNCHER_VERSION ?? "unknown",
      desktopShell: { version: process.env.PI_WEBAPP_DESKTOP_VERSION ?? "unknown", build: process.env.PI_WEBAPP_DESKTOP_BUILD ?? "unknown" },
      packageUpdates: this.desktopPackageUpdates, releaseChannels: this.desktopReleaseChannels,
      handoffProtocol: process.env.PI_WEBAPP_LAUNCHER_HANDOFF_PROTOCOL === "1" ? launcherHandoffProtocol : 0 };
  }

  /** Called only under the bridge's all-idle mutation gate. No generic stop/kill. */
  async requestLauncherHandoff(nonce: string, requestId: string): Promise<void> {
    if (!this.desktopManaged || !this.launcherNonce || nonce !== this.launcherNonce || this.launcherIdentity().handoffProtocol !== 1)
      throw new Error("旧后台启动器尚无安全交接协议，请先在稳定版通道升级业务包，再从桌面菜单重试；现有任务保持运行。");
    if (!/^[a-f0-9-]{36}$/i.test(requestId)) throw new Error("Invalid handoff request identity");
    if (this.preparing || this.restartPending || this.savingPreference || this.cancellation || this.preparedUpdate) throw new Error("升级或启动器交接正在进行中");
    await this.runningVersion();
    const transaction = await this.transaction();
    if (transaction && !terminal(transaction.phase)) throw new Error("请先完成或取消未完成的业务包更新，再交接启动器");
    const statePath = join(this.agentDir, "pi-web", "launcher.json");
    const owner = JSON.parse(await readFile(statePath, "utf8"));
    const matches = (state: typeof owner) => state.nonce === nonce && state.pid === owner.pid && state.runtimeKind === "desktop" && state.launcherHandoffProtocol === 1;
    if (!matches(owner)) throw new Error("后台启动器身份已变化，交接未执行");
    const prior = await readHandoff(this.agentDir);
    if (prior?.nonce === nonce && ["requested", "draining"].includes(prior.phase)) throw new Error("启动器交接尚未完成，请保留当前窗口");
    let resume: void | (() => Promise<void>) = undefined, accepted = false;
    try {
      if (!this.beforeRestart) throw new Error("后台缺少图稿排空协议，交接未执行");
      resume = await this.beforeRestart();
      if (!matches(JSON.parse(await readFile(statePath, "utf8")))) throw new Error("后台启动器身份已变化，交接未执行");
      const receipt = { protocol: 1, nonce, requestId, pid: owner.pid, phase: "requested" };
      try { await writeHandoff(this.agentDir, receipt); accepted = true; }
      catch (error) {
        const actual = await readHandoff(this.agentDir).catch(() => null);
        accepted = actual?.nonce === nonce && actual?.requestId === requestId && ["requested", "draining", "stopped"].includes(actual.phase);
        if (!accepted) throw error;
      }
      this.restartPending = true;
    } finally { if (!accepted && resume) await resume(); }
  }

  private async current(): Promise<string> {
    const pkg = JSON.parse(await readFile(join(this.packageRoot, "package.json"), "utf8"));
    if (pkg.name !== "pi-webapp") throw new Error("当前 pi-webapp 版本无效");
    parseVersion(pkg.version);
    return pkg.version;
  }

  /** Removes downloaded releases no pointer can start. Never while an update is in flight here or elsewhere. */
  async pruneReleases(): Promise<string[]> {
    if (this.preparing || this.preparedUpdate || this.restartPending || this.cancellation) return [];
    const transaction = await this.transaction();
    if (transaction && !terminal(transaction.phase)) return [];
    return pruneReleases({ agentDir: this.agentDir, packageRoot: this.packageRoot });
  }

  /** Settles a record no live operation of this process owns. Nothing here can fence an update:
   * the running version commits its own switch, everything else is history the next update supersedes. */
  async runningVersion(): Promise<string> {
    const current = await this.current(), transaction = await this.transaction();
    if (!transaction || terminal(transaction.phase) || transaction.id === this.ownTransaction) return current;
    if (transaction.version === current && ["selecting", "selected", "restart-requested"].includes(transaction.phase)) {
      await this.record({ ...transaction, phase: "committed", message: "Selected version is running" });
    } else if (transaction.phase === "restart-requested") {
      const outcome = await readUpgradeTransaction(this.agentDir);
      await this.record({ ...transaction, phase: "failed", message: outcome?.id === transaction.id && outcome.phase === "rolled-back" && outcome.message
        ? outcome.message : "The launcher did not start the new version; current version kept" });
    } else {
      await retireCandidate(this.agentDir, transaction.id, "superseded");
      await this.record({ ...transaction, phase: "failed", message: `Interrupted while ${transaction.phase} in an earlier run; superseded, current version kept` });
    }
    return current;
  }

  private get transactionPath(): string { return join(this.agentDir, "pi-web", "update-transaction.json"); }
  private async transaction(): Promise<UpdateTransaction | null> {
    let value: UpdateTransaction | null;
    // An unreadable/invalid record is quarantined (bytes retained), never a permanent update fence.
    try { value = await readJournal<UpdateTransaction>(this.transactionPath); }
    catch { await quarantineJournal(this.transactionPath); return null; }
    if (!value) return null;
    if (value.schema !== 1 || !/^[a-f0-9-]{36}$/.test(value.id) || typeof value.version !== "string" ||
        !["stable", "alpha"].includes(value.channel) || !["downloading", "validating", "prepared", "selecting", "selected", "restart-requested", "committed", "cancelled", "failed"].includes(value.phase) ||
        typeof value.selectionPath !== "string") { await quarantineJournal(this.transactionPath); return null; }
    return value;
  }
  private async record(transaction: UpdateTransaction): Promise<void> {
    await mkdir(join(this.agentDir, "pi-web"), { recursive: true });
    await atomicJson(this.transactionPath, transaction);
    if (terminal(transaction.phase)) {
      const directory = join(this.agentDir, "pi-web", "update-history"); await mkdir(directory, { recursive: true });
      await atomicJson(join(directory, `${transaction.id}-${transaction.phase}.json`), transaction);
    }
  }

  /** Cancels this host's own download or prepared candidate. Once the launcher holds the restart
   * request, the launcher owns the outcome (it admits the new version or rolls back by itself). */
  async cancel(): Promise<void> {
    if (this.cancellation) return this.cancellation;
    const cancellation = this.cancelUpdate(); this.cancellation = cancellation;
    try { await cancellation; } finally { this.cancellation = undefined; }
  }

  private async cancelUpdate(): Promise<void> {
    if (this.savingPreference) throw new Error("偏好保存中，请稍后取消");
    if (this.restartPending) throw new Error("重启已交给启动器；新版本启动失败时会自动恢复当前版本");
    if (this.preparing) { this.downloadAbort?.abort(new Error("Update cancelled")); await this.preparation?.catch(() => {}); }
    const transaction = await this.transaction(), candidate = await readCandidate(this.agentDir);
    if (candidate && (!transaction || candidate.id === transaction.id)) await retireCandidate(this.agentDir, candidate.id, "cancelled");
    if (transaction && !terminal(transaction.phase)) await this.record({ ...transaction, phase: "cancelled", message: "更新已取消；原版本及插件数据保留" });
    this.preparedUpdate = undefined;
  }

  private get preferencePath(): string { return join(this.agentDir, "pi-web", "update-preferences.json"); }

  private async channel(): Promise<UpdateChannel> {
    try {
      const preference = JSON.parse(await readFile(this.preferencePath, "utf8"));
      if (!preference || typeof preference !== "object" || !["stable", "alpha"].includes(preference.channel)) throw new Error("Invalid persisted update channel");
      return preference.channel;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "stable";
      throw new Error("无法读取更新偏好，请检查 update-preferences.json");
    }
  }

  async setChannel(channel: UpdateChannel): Promise<{ channel: UpdateChannel }> {
    if (channel !== "stable" && channel !== "alpha") throw new Error("更新通道无效");
    if (this.preparing || this.restartPending || this.savingPreference || this.cancellation) throw new Error("升级或偏好保存正在进行中");
    if (this.preparedUpdate && channel !== this.preparedUpdate.channel) await this.cancel();
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
    const current = await this.runningVersion();
    const channel = await this.channel();
    const sourceCheckout = existsSync(join(this.packageRoot, ".git"));
    const status: UpdateStatus = { current, channel, latest: null, available: false, canRestart: Boolean(this.launcherNonce) && !sourceCheckout };
    if (this.desktopManaged) { status.launcher = this.launcherIdentity(); status.launcherHandoff = { supported: status.launcher.handoffProtocol === 1, required: !this.desktopReleaseChannels }; }
    if (this.desktopManaged) status.desktopShell = { version: process.env.PI_WEBAPP_DESKTOP_VERSION ?? "unknown", build: process.env.PI_WEBAPP_DESKTOP_BUILD ?? "unknown" };
    const transaction = await this.transaction();
    if (transaction && !terminal(transaction.phase)) status.recovery = { version: transaction.version, phase: transaction.phase, canCancel: transaction.phase !== "restart-requested" };
    else if (transaction?.phase === "failed" && transaction.message) status.lastFailure = { version: transaction.version, message: transaction.message };
    if (this.desktopManaged && !this.desktopPackageUpdates) return { ...status, canRestart: false, requiresDesktopUpgrade: true,
      reason: "当前桌面外壳尚不支持业务包在线更新，请先安装新版桌面应用。" };
    if (this.desktopManaged && channel === "alpha" && !this.desktopReleaseChannels) return { ...status, canRestart: false,
      reason: status.launcherHandoff?.supported
        ? "当前后台仍由旧桌面启动器管理，尚不支持体验版持久化。已安装 build 14 或更新桌面时，请使用菜单「pi → 安全切换到当前桌面启动器…」完成交接，无需重复安装。"
        : "当前后台仍由旧桌面启动器管理，尚不支持体验版持久化。请先切回稳定版并升级业务包，再使用 build 14 或更新桌面菜单安全切换启动器；已安装新版桌面无需重复安装。" };
    if (sourceCheckout) status.reason = "当前从源码目录运行。网页升级仅支持 npm 安装的版本，以免覆盖本地代码。";
    else if (!status.canRestart) status.reason = "当前页面由 Pi 终端打开，无法从网页自动重启 Pi；请使用 pi-webapp 启动器。";
    if (this.desktopManaged && this.desktopPackageUpdates) {
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
      if (status.available && this.pluginWarnings) {
        // Advisory only: a plugin can never decide whether the host updates.
        const warnings = await this.pluginWarnings(latest).catch(() => []);
        if (warnings.length) status.pluginWarnings = warnings;
      }
      if (this.desktopManaged && status.downgrade && !this.desktopReleaseChannels && compareVersions(latest, process.env.PI_WEBAPP_DESKTOP_VERSION ?? current) < 0) {
        status.canRestart = false;
        status.requiresDesktopUpgrade = true;
        status.reason = "当前桌面外壳尚不支持切回低于内置包的版本，请先安装支持更新通道的新版桌面应用。";
      }
    } catch (error) {
      throw new Error(`检查 npm 更新失败：${error instanceof Error ? error.message : String(error)}`);
    }
    return status;
  }

  async prepare(request?: UpdateRequest): Promise<PreparedUpdate> {
    if (this.preparation) throw new Error("升级准备正在进行中");
    const preparation = this.prepareUpdate(request); this.preparation = preparation;
    try { return await preparation; } finally { this.preparation = undefined; }
  }

  /** Download and validate only, then write the candidate. The host selects nothing and holds no
   * cross-process lock; the launcher decides whether the candidate becomes the running version. */
  private async prepareUpdate(request?: UpdateRequest): Promise<PreparedUpdate> {
    if (this.desktopManaged && !this.desktopPackageUpdates) throw new Error("当前桌面应用不支持业务包在线更新，请先安装新版桌面应用");
    if (!this.launcherNonce) throw new Error("当前页面无法自动重启 Pi");
    if (existsSync(join(this.packageRoot, ".git"))) throw new Error("源码目录不能通过网页升级");
    if (this.restartPending) throw new Error("升级已完成，正在重启");
    if (this.cancellation) throw new Error("升级取消正在进行中");
    if (this.preparing || this.savingPreference) throw new Error("升级或偏好保存正在进行中");
    // A refused flush leaves the candidate intact. Retry that exact candidate, not a second download.
    if (this.preparedUpdate) {
      if (request && (request.version !== this.preparedUpdate.update.version || request.channel !== this.preparedUpdate.channel)) {
        const status = await this.check();
        if (request.channel !== status.channel || request.version !== status.latest) throw new Error("更新目标或偏好已变化，请重新检查更新");
        await this.cancel();
      } else return { ...this.preparedUpdate.update };
    }
    this.preparing = true; this.downloadAbort = new AbortController();
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
      const selectionPath = join(this.agentDir, "pi-web", this.desktopManaged ? "desktop-update.json" : "update.json");
      let transaction: UpdateTransaction = { schema: 1, id: randomUUID(), phase: "downloading", version: status.latest, channel: status.channel ?? "stable", selectionPath, ownerNonce: this.launcherNonce };
      this.ownTransaction = transaction.id;
      await this.record(transaction);
      try {
        const peers = this.desktopManaged ? await this.targetPeerSpecs(status.latest) : [];
        await this.runNpm(["install", `pi-webapp@${status.latest}`, ...peers, "--prefix", releaseDir, "--ignore-scripts", "--no-save", "--no-audit", "--no-fund", ...(this.desktopManaged ? ["--engine-strict"] : [])], this.downloadAbort.signal);
        this.downloadAbort.signal.throwIfAborted();
        const installed = join(releaseDir, "node_modules", "pi-webapp");
        transaction = { ...transaction, phase: "validating", packageRoot: installed }; await this.record(transaction);
        const pkg = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
        if (pkg.name !== "pi-webapp" || pkg.version !== status.latest) throw new Error("下载的包与目标版本不符");
        const currentPackage = JSON.parse(await readFile(join(this.packageRoot, "package.json"), "utf8"));
        if (status.downgrade && dataVersion(pkg) !== dataVersion(currentPackage)) throw new Error("数据格式不兼容，不能直接切回旧版。请先备份并按恢复指南操作。");
        const launcher = join(installed, "bin", "pi-webapp.mjs");
        await Promise.all([launcher, join(installed, "dist", "extension.js"), join(installed, "web", "dist", "index.html")].map((path) => access(path)));
        if (this.desktopManaged) {
          await validateDesktopRelease(this.agentDir, { version: status.latest, launcher, desktopProtocolVersion });
          await this.verifyPackage(this.packageRoot, installed);
        }
        // Plugins are never part of the decision: prefetch is best effort and its failures stay on plugin cards.
        await this.prefetchPlugins?.(status.latest, this.downloadAbort.signal).catch(() => {});
        this.downloadAbort.signal.throwIfAborted();
        await writeCandidate(this.agentDir, { id: transaction.id, version: status.latest, launcher, packageRoot: installed, channel: status.channel ?? "stable", downgrade: !!status.downgrade });
        transaction = { ...transaction, phase: "prepared" }; await this.record(transaction);
        this.preparedUpdate = { id: transaction.id, update: { version: status.latest, launcher }, channel: status.channel ?? "stable" };
        return { version: status.latest, launcher };
      } catch (error) {
        // Nothing was selected: the downloaded release is not referenced by any pointer.
        await rm(releaseDir, { recursive: true, force: true });
        // Keep the actual cause: a fence or npm error must not be recorded as a generic download failure.
        const cause = (error instanceof Error ? error.message : String(error)).slice(0, 500);
        await this.record({ ...transaction, phase: this.downloadAbort.signal.aborted ? "cancelled" : "failed", message: this.downloadAbort.signal.aborted ? "下载已取消；当前版本及插件数据保留" : `下载或验证失败：${cause}；当前版本和插件数据保留` });
        throw error;
      }
    } finally { this.preparing = false; this.downloadAbort = undefined; }
  }

  /** force: the user confirmed proceeding past plugin views/work that did not drain in time. */
  async requestRestart(prepared: PreparedUpdate, { force = false }: { force?: boolean } = {}): Promise<void> {
    if (this.desktopManaged && !this.desktopPackageUpdates) throw new Error("当前桌面应用不支持业务包在线更新");
    if (!this.launcherNonce) throw new Error("当前页面无法自动重启 Pi");
    const staged = this.preparedUpdate;
    if (!staged || staged.update.version !== prepared.version || staged.update.launcher !== prepared.launcher) throw new Error("没有已准备的更新，请重新检查更新");
    let resume: void | (() => Promise<void>) = undefined, restartWritten = false;
    const path = join(this.agentDir, "pi-web", "launcher.restart");
    try {
      resume = await this.beforeRestart?.(force);
      if ((await readCandidate(this.agentDir))?.id !== staged.id) throw new Error("更新候选已过期或被替换，请重新检查更新");
      const transaction = await this.transaction();
      if (transaction?.id === staged.id) await this.record({ ...transaction, phase: "restart-requested" });
      // Only the live launcher's own nonce is meaningful; another nonce's marker is stale, kept aside.
      try {
        const existing = JSON.parse(await readFile(path, "utf8"));
        if (existing?.nonce !== this.launcherNonce) {
          const history = join(this.agentDir, "pi-web", "restart-history"); await mkdir(history, { recursive: true, mode: 0o700 });
          await rename(path, join(history, `stale-${randomUUID()}.json`));
        }
      } catch { /* No marker, or unreadable: the exclusive write below decides. */ }
      try { await writeFile(path, JSON.stringify({ nonce: this.launcherNonce, candidate: staged.id }), { mode: 0o600, flag: "wx" }); restartWritten = true; }
      catch (error) {
        // A write error can occur after bytes reached disk. Never undo an accepted handoff.
        try { const marker = JSON.parse(await readFile(path, "utf8")); restartWritten = marker.nonce === this.launcherNonce && marker.candidate === staged.id; } catch {}
        if (!restartWritten) throw error;
      }
      this.restartPending = true;
    } catch (error) {
      if (restartWritten) { this.restartPending = true; return; }
      const transaction = await this.transaction();
      if (transaction?.id === staged.id && transaction.phase === "restart-requested") await this.record({ ...transaction, phase: "prepared" });
      if (resume) await resume();
      throw error;
    }
  }
}
