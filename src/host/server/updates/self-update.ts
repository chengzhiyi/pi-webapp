import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fingerprint, type HostedPairTransaction } from "./hosted-pair.ts";
import { atomicJson, readJournal, withStorageLock } from "../plugins/hosted/storage.ts";
import { promisify } from "node:util";
import { npmCommand } from "../../../../bin/npm-command.mjs";
import { desktopProtocolVersion, readDesktopRelease, validateDesktopRelease, writeDesktopRelease } from "../../../../desktop/managed-release.mjs";
import { launcherHandoffProtocol, readHandoff, writeHandoff } from "../../../../desktop/launcher-handoff.mjs";
import { desktopPeerSpecs, exactSdkPeerSpecs, verifyDesktopPackage } from "./desktop-package.ts";

const execFileAsync = promisify(execFile);
import { compareVersions, isStableVersion, isAlphaVersion, parseVersion } from "../../../../desktop/release-version.mjs";
export { compareVersions } from "../../../../desktop/release-version.mjs";

import type { UpdateChannel, UpdateRequest, UpdateStatus } from "../../../contracts/bridge-contract.ts";
export type { UpdateStatus } from "../../../contracts/bridge-contract.ts";
export interface PreparedUpdate { version: string; launcher: string }
interface UpdateTransaction {
  schema: 1; id: string; phase: "downloading" | "validating" | "prepared" | "selecting" | "selected" | "restart-requested" | "committed" | "cancelled" | "failed";
  version: string; channel: UpdateChannel; packageRoot?: string;
  selectionPath: string; before?: string | null; selectedDigest?: string; message?: string; ownerNonce?: string;
  legacyRecovery?: boolean;
}

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
  private readonly validateHostedPair?: (version: string, packageRoot: string) => Promise<void>;
  private readonly hostedPair?: HostedPairTransaction;
  private preparing = false;
  private preparation?: Promise<PreparedUpdate>;
  private cancellation?: Promise<void>;
  private downloadAbort?: AbortController;
  private savingPreference = false;
  private restartPending = false;
  private preparedUpdate?: { update: PreparedUpdate; channel: UpdateChannel; select: () => Promise<void> };
  private readonly beforeRestart?: () => Promise<void | (() => Promise<void>)>;

  constructor(options: { agentDir: string; packageRoot: string; launcherNonce?: string; runNpm?: (args: string[], signal?: AbortSignal) => Promise<string>; desktopManaged?: boolean;
    desktopPackageUpdates?: boolean; desktopReleaseChannels?: boolean; peerSpecs?: typeof desktopPeerSpecs; verifyPackage?: typeof verifyDesktopPackage;
    validateHostedPair?: (version: string, packageRoot: string) => Promise<void>; hostedPair?: HostedPairTransaction;
    /** Drain hosted workers/views while authenticated HTTP is still available, before launcher EOF. */
    beforeRestart?: () => Promise<void | (() => Promise<void>)> }) {
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
    this.validateHostedPair = options.validateHostedPair;
    this.hostedPair = options.hostedPair;
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
    if (transaction && !["committed", "cancelled", "failed"].includes(transaction.phase)) throw new Error("请先完成或取消未完成的业务包更新，再交接启动器");
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

  async runningVersion(): Promise<string> {
    const current = await this.current(), transaction = await this.transaction();
    if (transaction?.phase === "restart-requested" && transaction.version === current && (!this.hostedPair || (await this.hostedPair.status?.())?.phase === "reconciled")) {
      await this.record({ ...transaction, phase: "committed", message: "Selected host is running and hosted protocol health admission completed" });
    }
    return current;
  }

  private get transactionPath(): string { return join(this.agentDir, "pi-web", "update-transaction.json"); }
  private async transaction(): Promise<UpdateTransaction | null> {
    try {
      const value = await readJournal<UpdateTransaction>(this.transactionPath);
      if (!value) return null;
      if (value.schema !== 1 || !/^[a-f0-9-]{36}$/.test(value.id) || typeof value.version !== "string" ||
          !["stable", "alpha"].includes(value.channel) || !["downloading", "validating", "prepared", "selecting", "selected", "restart-requested", "committed", "cancelled", "failed"].includes(value.phase) ||
          value.selectionPath !== join(this.agentDir, "pi-web", this.desktopManaged ? "desktop-update.json" : "update.json") ||
          value.selectedDigest !== undefined && !/^[a-f0-9]{64}$/.test(value.selectedDigest) ||
          value.before !== undefined && value.before !== null && (typeof value.before !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.before))) throw new Error("更新事务记录无效，请保留记录并检查诊断");
      return value;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  private async record(transaction: UpdateTransaction): Promise<void> {
    await mkdir(join(this.agentDir, "pi-web"), { recursive: true });
    await atomicJson(this.transactionPath, transaction);
    if (["failed", "cancelled", "committed"].includes(transaction.phase)) {
      const directory = join(this.agentDir, "pi-web", "update-history"); await mkdir(directory, { recursive: true });
      await atomicJson(join(directory, `${transaction.id}-${transaction.phase}.json`), transaction);
    }
  }
  /** A different nonce is not evidence that an older launcher stopped. Recovery
   * requires both its exact rollback bytes and this backend's current launcher
   * receipt. PID liveness/expiry is never used to steal an update transaction.
   */
  private async admittedFallback(transaction: UpdateTransaction, current?: string): Promise<boolean> {
    if (!transaction.ownerNonce || !this.launcherNonce || transaction.ownerNonce === this.launcherNonce || transaction.before === undefined) return false;
    const version = current ?? await this.current();
    if (transaction.version === version) return false;
    try {
      const owner = await readJournal<{ nonce?: string; version?: string; piPid?: number }>(join(this.agentDir, "pi-web", "launcher.json"));
      if (owner?.nonce !== this.launcherNonce || owner.version !== version || owner.piPid !== process.pid) return false;
      let pointer: string | null;
      try { pointer = (await readFile(transaction.selectionPath)).toString("base64"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false; pointer = null; }
      return pointer === transaction.before;
    } catch { return false; }
  }
  /** Legacy selected has no durable handoff phase. Only the published current
   * backend may recover it, and a live restart marker makes acceptance ambiguous.
   */
  private async admittedLegacyRecovery(current?: string): Promise<boolean> {
    if (!this.launcherNonce) return false;
    try {
      const owner = await readJournal<{ nonce?: string; version?: string; piPid?: number }>(join(this.agentDir, "pi-web", "launcher.json"));
      if (owner?.nonce !== this.launcherNonce || owner.piPid !== process.pid || owner.version !== (current ?? await this.current())) return false;
      try { await access(join(this.agentDir, "pi-web", "launcher.restart")); return false; }
      catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
    } catch { return false; }
  }
  /** Cancel only this process's uncommitted handoff, compare-and-swap the pointer,
   * and retain both the transaction and all plugin data for inspection/recovery. */
  async cancel(): Promise<void> {
    if (this.cancellation) return this.cancellation;
    const cancellation = this.cancelUpdate(); this.cancellation = cancellation;
    try { await cancellation; } finally { this.cancellation = undefined; }
  }

  private async cancelUpdate(): Promise<void> {
    if (this.savingPreference) throw new Error("偏好保存中，请稍后取消");
    if (this.preparing) { this.downloadAbort?.abort(new Error("Update cancelled")); await this.preparation?.catch(() => {}); }
    let transaction = await this.transaction();
    if (!transaction || ["cancelled", "failed", "committed"].includes(transaction.phase)) {
      // Upgrade legacy selected journals without deleting them or guessing a plugin rollback.
      const intent = await this.hostedPair?.status?.();
      if (intent && !["cancelled", "reconciled", "prepared"].includes(intent.phase)) {
        if (!await this.admittedLegacyRecovery()) throw new Error("旧事务恢复需要当前后台的归属收据，且不能中断启动器已接受的交接");
        const selectionPath = join(this.agentDir, "pi-web", this.desktopManaged ? "desktop-update.json" : "update.json");
        if (!intent.selection || intent.selection.path !== selectionPath) throw new Error("旧升级事务缺少版本选择收据，请保留记录并检查恢复诊断");
        const bytes = await readFile(selectionPath);
        if (fingerprint(bytes.toString("base64")) !== intent.selection.digest) throw new Error("旧升级选择已变化，恢复未覆盖其他操作");
        const selected = JSON.parse(bytes.toString("utf8")), current = await this.current();
        const currentLauncher = join(this.packageRoot, "bin", "pi-webapp.mjs"); await access(currentLauncher);
        const previous = selected.previous?.version === current && selected.previous.launcher === currentLauncher ? selected.previous
          : this.desktopManaged ? await validateDesktopRelease(this.agentDir, { version: current, launcher: currentLauncher, desktopProtocolVersion })
          : { version: current, launcher: currentLauncher, baseVersion: selected.baseVersion ?? current };
        transaction = { schema: 1, id: intent.id, phase: "selected", version: intent.version, channel: await this.channel(), packageRoot: intent.packageRoot,
          selectionPath, before: Buffer.from(JSON.stringify(previous)).toString("base64"), selectedDigest: intent.selection.digest,
          ownerNonce: this.launcherNonce, legacyRecovery: true };
        await this.record(transaction);
      } else if (intent?.phase === "prepared") await this.hostedPair?.cancel?.(intent.version, intent.packageRoot);
    }
    if (!transaction || ["cancelled", "failed", "committed"].includes(transaction.phase)) {
      const intent = await this.hostedPair?.status?.();
      if (intent?.phase === "prepared") await this.hostedPair?.cancel?.(intent.version, intent.packageRoot);
      this.preparedUpdate = undefined; this.restartPending = false; return;
    }
    if (transaction.legacyRecovery && !await this.admittedLegacyRecovery()) throw new Error("旧事务恢复的后台归属或交接状态已变化，请从当前运行实例恢复");
    if (transaction.phase === "restart-requested" && !await this.admittedFallback(transaction)) throw new Error("重启已交给启动器；当前入口没有已确认回退的归属收据，不能取消其他运行实例的交接");
    const selectedTransaction = transaction;
    const restoreSelection = async () => {
      if (selectedTransaction.legacyRecovery && !await this.admittedLegacyRecovery()) throw new Error("旧事务恢复的归属或交接收据已变化，取消未覆盖其他运行实例");
      if (selectedTransaction.phase === "restart-requested" && !await this.admittedFallback(selectedTransaction)) throw new Error("重启交接的归属或回退收据已变化，取消未覆盖其他运行实例");
      if (!selectedTransaction.selectedDigest) return;
      let bytes: Buffer | null;
      try { bytes = await readFile(selectedTransaction.selectionPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; bytes = null; }
      // The pointer write may have failed before rename, or the launcher may
      // already have restored these exact bytes. Either case needs no overwrite.
      if ((bytes?.toString("base64") ?? null) === selectedTransaction.before) return;
      if (!bytes || fingerprint(bytes.toString("base64")) !== selectedTransaction.selectedDigest) throw new Error("版本选择已被其他操作更改，取消未覆盖该选择；当前数据已保留");
      if (selectedTransaction.before === null) await rm(selectedTransaction.selectionPath);
      else if (typeof selectedTransaction.before === "string") {
        const temporary = `${selectedTransaction.selectionPath}.${randomUUID()}.tmp`;
        try { await writeFile(temporary, Buffer.from(selectedTransaction.before, "base64"), { mode: 0o600 }); await rename(temporary, selectedTransaction.selectionPath); }
        finally { await rm(temporary, { force: true }); }
      } else throw new Error("缺少旧版本选择收据，不能自动恢复；请保留事务记录");
    };
    if (this.hostedPair?.cancel) await this.hostedPair.cancel(transaction.version, transaction.packageRoot, restoreSelection);
    else await withStorageLock(join(this.agentDir, "pi-web", "update-control"), restoreSelection);
    await this.record({ ...transaction, phase: "cancelled", message: "更新已取消；原版本及插件数据保留" });
    this.preparedUpdate = undefined; this.restartPending = false;
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
    const transaction = await this.transaction(), pair = await this.hostedPair?.status?.();
    if (transaction && !["failed", "cancelled", "committed"].includes(transaction.phase)) status.recovery = { version: transaction.version, phase: transaction.phase,
      canCancel: transaction.legacyRecovery ? await this.admittedLegacyRecovery(current) : transaction.phase !== "restart-requested" || await this.admittedFallback(transaction, current) };
    else if (pair && !["cancelled", "reconciled"].includes(pair.phase)) status.recovery = { version: pair.version, phase: pair.phase,
      canCancel: pair.phase === "prepared" || await this.admittedLegacyRecovery(current) };
    if (this.desktopManaged && !this.desktopPackageUpdates) return { ...status, canRestart: false, requiresDesktopUpgrade: true,
      reason: "当前桌面外壳尚不支持业务包在线更新，请先安装新版桌面应用。" };
    if (this.desktopManaged && channel === "alpha" && !this.desktopReleaseChannels) return { ...status, canRestart: false,
      reason: status.launcherHandoff?.supported
        ? "当前后台仍由旧桌面启动器管理，尚不支持体验版持久化。已安装 build 13 或更新桌面时，请使用菜单「pi → 安全切换到当前桌面启动器…」完成交接，无需重复安装。"
        : "当前后台仍由旧桌面启动器管理，尚不支持体验版持久化。请先切回稳定版并升级业务包，再使用 build 13 或更新桌面菜单安全切换启动器；已安装新版桌面无需重复安装。" };
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

  private async prepareUpdate(request?: UpdateRequest): Promise<PreparedUpdate> {
    if (this.desktopManaged && !this.desktopPackageUpdates) throw new Error("当前桌面应用不支持业务包在线更新，请先安装新版桌面应用");
    if (!this.launcherNonce) throw new Error("当前页面无法自动重启 Pi");
    if (existsSync(join(this.packageRoot, ".git"))) throw new Error("源码目录不能通过网页升级");
    if (this.restartPending) throw new Error("升级已完成，正在重启");
    if (this.cancellation) throw new Error("升级取消正在进行中");
    if (this.preparing || this.savingPreference) throw new Error("升级或偏好保存正在进行中");
    // A refused flush leaves the selected pair intact. Retry that exact selection,
    // not a second download/select transaction blocked by our own pending journal.
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
      await this.record(transaction);
      let selectionAttempted = false;
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
        // Both npm launcher and desktop-package selection use the same precommit gate.
        await this.validateHostedPair?.(status.latest, installed);
        const desktopSelection = this.desktopManaged ? await validateDesktopRelease(this.agentDir, { version: status.latest, launcher, desktopProtocolVersion }) : null;
        if (this.desktopManaged) await this.verifyPackage(this.packageRoot, installed);
        const writeSelection = async () => {
          let before: Buffer | null;
          try { before = await readFile(selectionPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; before = null; }
          transaction = { ...transaction, phase: "selecting", before: before?.toString("base64") ?? null }; await this.record(transaction);
          selectionAttempted = true;
          if (this.desktopManaged) {
            const selected = desktopSelection!;
            const saved = await readDesktopRelease(this.agentDir, status.current);
            const previous = saved?.version === status.current ? saved : null;
            const fallbackVersion = process.env.PI_WEBAPP_DESKTOP_VERSION ?? saved?.fallbackVersion ?? status.current;
            const selection = { ...selected, ...((status.downgrade || saved?.fallbackVersion) ? { fallbackVersion } : {}), ...(previous ? { previous } : {}) };
            transaction = { ...transaction, selectedDigest: fingerprint(Buffer.from(JSON.stringify(selection)).toString("base64")) }; await this.record(transaction);
            await writeDesktopRelease(this.agentDir, selection);
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
              const selection = { version: status.latest, launcher, baseVersion, ...((status.downgrade || saved?.allowDowngrade === true) ? { allowDowngrade: true } : {}), ...(previous ? { previous } : {}) };
              transaction = { ...transaction, selectedDigest: fingerprint(Buffer.from(JSON.stringify(selection)).toString("base64")) }; await this.record(transaction);
              await writeFile(temporary, JSON.stringify(selection), { mode: 0o600 });
              await rename(temporary, join(stateDir, "update.json"));
            } finally { await rm(temporary, { force: true }); }
          }
          const path = join(this.agentDir, "pi-web", this.desktopManaged ? "desktop-update.json" : "update.json");
          return { path, digest: fingerprint((await readFile(path)).toString("base64")) };
        };
        if (this.hostedPair?.stage) await this.hostedPair.stage(status.latest, installed, this.downloadAbort.signal);
        this.downloadAbort.signal.throwIfAborted();
        transaction = { ...transaction, phase: "prepared" }; await this.record(transaction);
        this.preparedUpdate = { update: { version: status.latest, launcher }, channel: status.channel ?? "stable", select: async () => {
          if (this.hostedPair) await this.hostedPair.select(status.latest!, installed, writeSelection);
          else await withStorageLock(join(this.agentDir, "pi-web", "update-control"), writeSelection);
          transaction = { ...transaction, phase: "selected" }; await this.record(transaction);
        } };
        return { version: status.latest, launcher };
      } catch (error) {
        // A failed write can be an acknowledged-on-disk rename. Retain potentially selected
        // code and journal for recovery rather than leaving a dangling launcher pointer.
        if (!selectionAttempted) await rm(releaseDir, { recursive: true, force: true });
        await this.record({ ...transaction, phase: this.downloadAbort.signal.aborted ? "cancelled" : "failed", message: this.downloadAbort.signal.aborted ? "下载已取消；当前版本及插件数据保留" : "下载或验证失败；当前版本和插件数据保留" });
        throw error;
      }
    } finally { this.preparing = false; this.downloadAbort = undefined; }
  }

  async requestRestart(prepared: PreparedUpdate): Promise<void> {
    if (this.desktopManaged && !this.desktopPackageUpdates) throw new Error("当前桌面应用不支持业务包在线更新");
    if (!this.launcherNonce) throw new Error("当前页面无法自动重启 Pi");
    let resume: void | (() => Promise<void>) = undefined, restartWritten = false;
    try {
      resume = await this.beforeRestart?.();
      await this.preparedUpdate?.select();
      const writeRestart = async () => {
        const path = join(this.agentDir, "pi-web", "launcher.restart");
        const transaction = await this.transaction();
        if (transaction) await this.record({ ...transaction, phase: "restart-requested" });
        try { await writeFile(path, JSON.stringify({ nonce: this.launcherNonce, launcher: prepared.launcher }), { mode: 0o600, flag: "wx" }); restartWritten = true; }
        catch (error) {
          // A write error can occur after bytes reached disk. Never undo an accepted handoff.
          try { const marker = JSON.parse(await readFile(path, "utf8")); restartWritten = marker.nonce === this.launcherNonce && marker.launcher === prepared.launcher; } catch {}
          if (!restartWritten) throw error;
        }
      };
      if (this.hostedPair) await this.hostedPair.restart(prepared.version, dirname(dirname(prepared.launcher)), writeRestart);
      else await writeRestart();
      this.restartPending = true;
    } catch (error) {
      if (restartWritten) { this.restartPending = true; return; }
      this.restartPending = false;
      const transaction = await this.transaction();
      if (transaction?.phase === "restart-requested") await this.record({ ...transaction, phase: "selected", message: "Restart marker was not accepted; reverting owned selection" });
      const staged = this.preparedUpdate;
      try { await this.cancel(); this.preparedUpdate = staged; } finally { if (resume) await resume(); }
      throw error;
    }
  }
}
