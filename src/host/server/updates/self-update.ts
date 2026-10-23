import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { npmCommand } from "../../../../bin/npm-command.mjs";
import { desktopProtocolVersion, readDesktopRelease, validateDesktopRelease, writeDesktopRelease } from "../../../../desktop/managed-release.mjs";
import { desktopPeerSpecs, verifyDesktopPackage } from "./desktop-package.ts";

const execFileAsync = promisify(execFile);
const releasePattern = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

import type { UpdateStatus } from "../../../contracts/bridge-contract.ts";
export type { UpdateStatus } from "../../../contracts/bridge-contract.ts";
export interface PreparedUpdate { version: string; launcher: string }

export function compareVersions(a: string, b: string): number {
  const first = releasePattern.exec(a);
  const second = releasePattern.exec(b);
  if (!first || !second) throw new Error("版本号无效");
  for (let index = 1; index <= 3; index++) {
    const difference = Number(first[index]) - Number(second[index]);
    if (difference) return difference;
  }
  if (!first[4] && second[4]) return 1;
  if (first[4] && !second[4]) return -1;
  return (first[4] ?? "").localeCompare(second[4] ?? "", undefined, { numeric: true });
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
  private readonly peerSpecs: typeof desktopPeerSpecs;
  private readonly verifyPackage: typeof verifyDesktopPackage;
  private preparing = false;
  private restartPending = false;

  constructor(options: { agentDir: string; packageRoot: string; launcherNonce?: string; runNpm?: (args: string[]) => Promise<string>; desktopManaged?: boolean;
    desktopPackageUpdates?: boolean; peerSpecs?: typeof desktopPeerSpecs; verifyPackage?: typeof verifyDesktopPackage }) {
    this.agentDir = options.agentDir;
    this.packageRoot = options.packageRoot;
    this.launcherNonce = options.launcherNonce;
    this.runNpm = options.runNpm ?? npm;
    this.desktopManaged = options.desktopManaged ?? process.env.PI_WEBAPP_RUNTIME === "desktop";
    // Old shells retain their protection until upgraded once to a capable shell.
    this.desktopPackageUpdates = options.desktopPackageUpdates ?? process.env.PI_WEBAPP_DESKTOP_PACKAGE_UPDATES === "1";
    this.peerSpecs = options.peerSpecs ?? desktopPeerSpecs;
    this.verifyPackage = options.verifyPackage ?? verifyDesktopPackage;
  }

  private async current(): Promise<string> {
    const pkg = JSON.parse(await readFile(join(this.packageRoot, "package.json"), "utf8"));
    if (pkg.name !== "pi-webapp" || typeof pkg.version !== "string" || !releasePattern.test(pkg.version)) throw new Error("当前 pi-webapp 版本无效");
    return pkg.version;
  }

  async runningVersion(): Promise<string> { return this.current(); }

  async check(): Promise<UpdateStatus> {
    const current = await this.current();
    if (this.desktopManaged && !this.desktopPackageUpdates) return { current, latest: null, available: false, canRestart: false,
      reason: "当前桌面外壳尚不支持业务包在线更新，请先安装新版桌面应用。" };
    const sourceCheckout = existsSync(join(this.packageRoot, ".git"));
    const status: UpdateStatus = { current, latest: null, available: false, canRestart: Boolean(this.launcherNonce) && !sourceCheckout };
    if (sourceCheckout) status.reason = "当前从源码目录运行。网页升级仅支持 npm 安装的版本，以免覆盖本地代码。";
    else if (!status.canRestart) status.reason = "当前页面由 Pi 终端打开，无法从网页自动重启 Pi；请使用 pi-webapp 启动器。";
    if (this.desktopManaged && this.desktopPackageUpdates) {
      status.desktopShell = { version: process.env.PI_WEBAPP_DESKTOP_VERSION ?? "unknown", build: process.env.PI_WEBAPP_DESKTOP_BUILD ?? "unknown" };
      if (status.canRestart) status.reason = "业务包更新安装到用户目录，不修改 pi.app。请先结束所有聊天任务并关闭终端，再升级并重启后台。";
    }
    try {
      const result: unknown = JSON.parse((await this.runNpm(["view", "pi-webapp", "dist-tags.latest", "--json", "--prefer-online"])).trim());
      // npm 12 wraps scalar JSON results in an array; older npm returns a string.
      const latest = Array.isArray(result) && result.length === 1 ? result[0] : result;
      if (typeof latest !== "string" || !releasePattern.test(latest)) throw new Error("npm 返回的版本号无效");
      status.latest = latest;
      status.available = compareVersions(latest, current) > 0;
    } catch (error) {
      throw new Error(`检查 npm 更新失败：${error instanceof Error ? error.message : String(error)}`);
    }
    return status;
  }

  async prepare(): Promise<PreparedUpdate> {
    if (this.desktopManaged && !this.desktopPackageUpdates) throw new Error("当前桌面应用不支持业务包在线更新，请先安装新版桌面应用");
    if (!this.launcherNonce) throw new Error("当前页面无法自动重启 Pi");
    if (existsSync(join(this.packageRoot, ".git"))) throw new Error("源码目录不能通过网页升级");
    if (this.restartPending) throw new Error("升级已完成，正在重启");
    if (this.preparing) throw new Error("升级正在进行中");
    this.preparing = true;
    try {
      const status = await this.check();
      if (!status.available || !status.latest) throw new Error("当前已是最新版本");
      const releases = join(this.agentDir, "pi-web", "releases");
      await mkdir(releases, { recursive: true });
      // Never delete a potentially live installation selected by another process.
      const releaseDir = await mkdtemp(join(await realpath(releases), `${status.latest}-`));
      try {
        const peers = this.desktopManaged ? await this.peerSpecs(this.packageRoot) : [];
        await this.runNpm(["install", `pi-webapp@${status.latest}`, ...peers, "--prefix", releaseDir, "--ignore-scripts", "--no-save", "--no-audit", "--no-fund", ...(this.desktopManaged ? ["--engine-strict"] : [])]);
        const installed = join(releaseDir, "node_modules", "pi-webapp");
        const pkg = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
        if (pkg.name !== "pi-webapp" || pkg.version !== status.latest) throw new Error("下载的包与目标版本不符");
        const launcher = join(installed, "bin", "pi-webapp.mjs");
        await Promise.all([launcher, join(installed, "dist", "extension.js"), join(installed, "web", "dist", "index.html")].map((path) => access(path)));
        if (this.desktopManaged) {
          const selected = await validateDesktopRelease(this.agentDir, { version: status.latest, launcher, desktopProtocolVersion });
          await this.verifyPackage(this.packageRoot, installed);
          const saved = await readDesktopRelease(this.agentDir, status.current);
          const previous = saved?.version === status.current ? saved : null;
          await writeDesktopRelease(this.agentDir, { ...selected, ...(previous ? { previous } : {}) });
        } else {
          const stateDir = join(this.agentDir, "pi-web");
          const temporary = join(stateDir, `update.${randomUUID()}.tmp`);
          try {
            await writeFile(temporary, JSON.stringify({ version: status.latest, launcher }), { mode: 0o600 });
            await rename(temporary, join(stateDir, "update.json"));
          } finally { await rm(temporary, { force: true }); }
        }
        this.restartPending = true;
        return { version: status.latest, launcher };
      } catch (error) {
        await rm(releaseDir, { recursive: true, force: true });
        throw error;
      }
    } finally { this.preparing = false; }
  }

  async requestRestart(prepared: PreparedUpdate): Promise<void> {
    if (this.desktopManaged && !this.desktopPackageUpdates) throw new Error("当前桌面应用不支持业务包在线更新");
    if (!this.launcherNonce) throw new Error("当前页面无法自动重启 Pi");
    try {
      await writeFile(join(this.agentDir, "pi-web", "launcher.restart"), JSON.stringify({ nonce: this.launcherNonce, launcher: prepared.launcher }), { mode: 0o600 });
    } catch (error) { this.restartPending = false; throw error; }
  }
}
