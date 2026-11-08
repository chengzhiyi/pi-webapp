import { spawn } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { desktopProtocolVersion, readDesktopRelease, rollbackDesktopRelease } from "./managed-release.mjs";
import { randomUUID } from "node:crypto";
import { readHandoff, readHandoffIntent, writeHandoffIntent } from "./launcher-handoff.mjs";
import { observeStopOutcome } from "./stop-outcome.mjs";
import { localize as t } from "./locale.mjs";
import { resetUpgradeState } from "./reset-upgrade.mjs";

export function localAddress(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password
      || url.pathname !== "/" || url.search || !/^[A-Za-z0-9_-]{32}$/.test(url.hash.slice(1))) {
    throw new Error(t("后端返回了无效的本地地址", "The backend returned an invalid local address"));
  }
  return url;
}

export function externalAddress(value) {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function sameDocument(value, backendUrl) {
  try {
    const url = new URL(value);
    return url.origin === new URL(backendUrl).origin && url.pathname === "/" && !url.search;
  } catch { return false; }
}

export function alive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === "EPERM"; }
}

export function runtimeEnvironment(base, { node, npmCli, piCli }) {
  // Never inherit a dev launcher/restart request or Electron's special Node mode.
  const env = { ...base };
  for (const key of ["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "NODE_PATH", "PI_WEBAPP_RESTART_PORT", "PI_WEBAPP_RESTART_TOKEN",
    "PI_WEBAPP_LAUNCHER_NONCE", "PI_WEBAPP_PLUGIN_DEV_ROOTS"]) delete env[key];
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === "path") ?? "PATH";
  env[pathKey] = `${dirname(node)}${delimiter}${env[pathKey] ?? ""}`;
  return { ...env, PI_WEBAPP_AUTO_OPEN: "0", PI_WEBAPP_RUNTIME: "desktop", PI_WEBAPP_DESKTOP_PACKAGE_UPDATES: "1", PI_WEBAPP_DESKTOP_RELEASE_CHANNELS: "1", PI_WEBAPP_PI_CLI: piCli,
    npm_execpath: npmCli };
}

export const safeVersion = value => typeof value === "string" && /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(value) && value.length < 80 ? value : t("未知", "unknown");

/** Display-only identity of a published backend. launcher.json is untrusted input:
 * allow-list every field, cap lengths, strip control/bidi characters and never
 * carry the URL (its fragment is the access token). */
export function backendIdentity(state) {
  if (!state || typeof state !== "object") return undefined;
  const token = typeof state.url === "string" ? state.url.split("#")[1] : undefined;
  const cwd = typeof state.cwd === "string" && state.cwd.length < 400 && !/[\p{Cc}\p{Cf}]/u.test(state.cwd)
    && /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(state.cwd) && !(token && state.cwd.includes(token)) ? state.cwd : undefined;
  const pid = Number.isInteger(state.pid) && state.pid > 0 && state.pid < 2 ** 31 ? state.pid : undefined;
  return { version: safeVersion(state.version ?? state.launcherVersion), runtimeKind: ["desktop", "npm"].includes(state.runtimeKind) ? state.runtimeKind : t("未知", "unknown"),
    pid, cwd, stoppable: pid !== undefined && typeof state.nonce === "string" && state.nonce.length > 0 };
}

const quotePosix = value => `'${value.replaceAll("'", "'\\''")}'`;
const quotePowerShell = value => `'${value.replaceAll("'", "''")}'`;

/** The exact `pi-webapp stop` invocation through this shell's bundled Node and launcher,
 * so it works without a global install. It reads the same launcher.json and uses the
 * same nonce stop marker; the backend's cwd does not affect which instance it stops. */
export function formatStopCommand({ node, launcher, agentDir, force = false, platform = process.platform, home = homedir() }) {
  const args = force ? "stop --force" : "stop";
  const customDir = resolve(agentDir) !== resolve(join(home, ".pi", "agent"));
  if (platform === "win32") return `${customDir ? `$env:PI_CODING_AGENT_DIR=${quotePowerShell(agentDir)}; ` : ""}& ${quotePowerShell(node)} ${quotePowerShell(launcher)} ${args}`;
  return `${customDir ? `PI_CODING_AGENT_DIR=${quotePosix(agentDir)} ` : ""}${quotePosix(node)} ${quotePosix(launcher)} ${args}`;
}

const unreachableCodes = new Set(["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "EADDRNOTAVAIL", "EPIPE", "UND_ERR_SOCKET"]);
function healthFailure(error) {
  if (error?.name === "TimeoutError" || error?.cause?.name === "TimeoutError") {
    return new DesktopConnectionError("health-failed", t("已有本地服务在 5 秒内没有响应健康检查，可能正忙或已卡住。未停止或修改该服务。", "The existing local service did not answer its health check within 5 seconds. It may be busy or hung. It was not stopped or modified."), undefined, "timeout");
  }
  if (unreachableCodes.has(error?.cause?.code) || unreachableCodes.has(error?.code)) {
    return new DesktopConnectionError("health-failed", t("无法连接已有本地服务：连接被拒绝或被关闭。它可能已退出或仍在启动。未停止或修改该服务。", "Could not reach the existing local service: the connection was refused or closed. It may have exited or still be starting. It was not stopped or modified."), undefined, "unreachable");
  }
  // Fetch/redirect errors can contain URLs: never expose their raw messages/tokens.
  return new DesktopConnectionError("health-failed", t("已有本地服务的健康检查返回了异常响应。请检查原服务后重试；未停止或修改该服务。", "The existing local service returned an unexpected health check response. Check the original service and retry; it was not stopped or modified."), undefined, "failed");
}

export class DesktopConnectionError extends Error {
  constructor(code, message, browserUrl, reason) {
    super(message);
    this.name = "DesktopConnectionError";
    this.code = code;
    if (reason) this.reason = reason; // health-failed only: timeout | unreachable | failed | invalid
    // Only validated loopback URLs may be offered as a browser recovery action.
    this.browserUrl = browserUrl ? localAddress(browserUrl).href : undefined;
  }
}

// This is a narrow migration path for the released launcher that predates metadata,
// not an assumption that every unmarked/future backend supports our protocol.
const legacyVersions = new Set(["0.1.19"]);
// Published npm launchers before the independent-package shell protocol. Require
// their exact known identity AND authenticated wire probes; never broadly ignore versions.
const migrationVersions = new Set(["0.1.26", "0.1.27"]);
const maxProbeBytes = 16 * 1024 * 1024;
function sessionCompatible(value) {
  return value?.schemaVersion === 1 && typeof value.sessionId === "string" && value.sessionId.length > 0
    && typeof value.cwd === "string" && typeof value.idle === "boolean"
    && Array.isArray(value.messages) && Array.isArray(value.pluginEntries);
}

async function readProbe(response, firstLine = false) {
  if (!response.body) throw new Error("missing response body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxProbeBytes) throw new Error("probe too large");
      text += decoder.decode(value, { stream: true });
      if (firstLine && text.includes("\n")) return JSON.parse(text.slice(0, text.indexOf("\n")));
    }
    text += decoder.decode();
    if (firstLine) throw new Error("incomplete event frame");
    return JSON.parse(text);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Node/Pi remain outside Electron. The shared launcher owns the state-file lock. */
export class DesktopBackend {
  constructor({ agentDir, version, node, launcher, piCli, npmCli, cwd, env = process.env,
    spawnProcess = spawn, fetchRequest = fetch, isAlive = alive, timeoutMs = 70000 }) {
    Object.assign(this, { agentDir, version, node, launcher, piCli, npmCli, cwd, env,
      spawnProcess, fetchRequest, isAlive, timeoutMs });
    this.statePath = join(agentDir, "pi-web", "launcher.json");
    this.stopPath = join(agentDir, "pi-web", "launcher.stop");
    this.logPath = join(agentDir, "pi-web", "launcher.log");
    this.owned = false;
    this.bundled = { version, launcher, piCli };
  }

  /** Display-only: never run by the shell. A backend this desktop did not start is never stopped by it. */
  stopCommand({ force = false } = {}) {
    return formatStopCommand({ node: this.node, launcher: this.bundled.launcher, agentDir: this.agentDir, force });
  }

  async readState() {
    for (let attempt = 0; ; attempt++) {
      try { return JSON.parse(await readFile(this.statePath, "utf8")); }
      catch (error) {
        if (error.code === "ENOENT") return null;
        // Windows may briefly deny opens while an atomic replacement/deletion
        // is pending. Retry the read, never reinterpret denial as an absent owner.
        if (process.platform === "win32" && ["EPERM", "EACCES"].includes(error.code) && attempt < 10) { await delay(25); continue; }
        if (error instanceof SyntaxError) return { starting: true };
        throw error;
      }
    }
  }

  async request(url, path) {
    try {
      const response = await this.fetchRequest(`${url.origin}${path}`, {
        method: "GET", headers: { Authorization: `Bearer ${url.hash.slice(1)}` },
        signal: AbortSignal.timeout(5000), redirect: "error",
      });
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel();
        throw new DesktopConnectionError("authentication-failed", t("已有本地服务的认证失败。请从原 Web 入口检查服务；未停止或修改该服务。", "Authentication with the existing local service failed. Check the service from its original web entry point; it was not stopped or modified."));
      }
      if (!response.ok) {
        await response.body?.cancel();
        if (path !== "/api/update/version" && [404, 405].includes(response.status)) {
          throw new DesktopConnectionError("legacy-incompatible", t("已有旧版服务缺少桌面所需的会话/事件接口。可在浏览器继续使用；不会停止或升级该服务。", "The existing older service does not provide the session/event interfaces required by the desktop app. You can continue in the browser; the service will not be stopped or upgraded."), url.href);
        }
        throw new Error("unhealthy response");
      }
      return response;
    } catch (error) {
      if (error instanceof DesktopConnectionError) throw error;
      throw healthFailure(error);
    }
  }

  async validate(state) {
    let url;
    try { url = localAddress(state.url); }
    catch { throw new DesktopConnectionError("invalid-address", t("已有服务的本地地址无效；不会连接或接管未知服务。", "The existing service has an invalid local address. The desktop app will not connect to or take over an unknown service.")); }
    const result = await this.request(url, "/api/update/version");
    let current; let protocol;
    try { const identity = await result.json(); current = identity.current; protocol = identity.desktopProtocolVersion; }
    catch (error) {
      // The 5s signal also bounds the body: a stalled body is a timeout, not bad data.
      if (error?.name === "TimeoutError") throw healthFailure(error);
      throw new DesktopConnectionError("health-failed", t("本地服务健康检查返回无效数据；未停止或修改该服务。", "The local service health check returned invalid data; the service was not stopped or modified."), undefined, "invalid");
    }
    const browserUrl = typeof current === "string" ? url.href : undefined;
    if (typeof current !== "string") throw new DesktopConnectionError("health-failed", t("无法确认已有服务版本；未停止或修改该服务。", "Could not confirm the existing service version; it was not stopped or modified."), undefined, "invalid");
    const compatibleProtocol = state.desktopProtocolVersion === desktopProtocolVersion && protocol === desktopProtocolVersion;
    const migration = migrationVersions.has(current) && state.version === current && state.bridgeVersion === 1
      && state.runtimeKind === "npm" && state.desktopProtocolVersion === undefined && protocol === undefined;
    if ((current !== this.version && !compatibleProtocol && !migration) || (state.version !== undefined && state.version !== current)) {
      throw new DesktopConnectionError("version-incompatible", t(`尚未验证此版本组合的连接兼容性，或启动元数据与实际后台版本不一致。桌面内置后台 ${safeVersion(this.version)}；现有后台 ${safeVersion(current)}。可检查桌面更新，或在浏览器继续使用原服务；不会自动停止或升级后台。`, `Compatibility between these versions has not been verified, or the launch metadata does not match the actual backend version. Bundled desktop backend: ${safeVersion(this.version)}; existing backend: ${safeVersion(current)}. Check for desktop updates or continue using the original service in the browser; the backend will not be stopped or upgraded automatically.`), browserUrl);
    }
    if ((state.desktopProtocolVersion !== undefined && state.desktopProtocolVersion !== desktopProtocolVersion)
        || (protocol !== undefined && protocol !== desktopProtocolVersion)) {
      throw new DesktopConnectionError("protocol-incompatible", t("后台使用不支持的桌面连接协议，请更新桌面外壳。", "The backend uses an unsupported desktop connection protocol. Update the desktop shell."), browserUrl);
    }
    if (state.bridgeVersion === 1 && state.version === current && !migration) return state;
    if (state.bridgeVersion === 1 && !migration) {
      throw new DesktopConnectionError("metadata-incomplete", t("已有服务的启动器兼容信息不完整。可在浏览器继续使用原服务；不会接管或停止它。", "The existing service has incomplete launcher compatibility information. You can continue using it in the browser; the desktop app will not take over or stop it."), browserUrl);
    }
    if (state.bridgeVersion !== undefined && !migration) {
      throw new DesktopConnectionError("protocol-incompatible", t("已有服务使用不支持的启动器协议。可在浏览器继续使用原服务；桌面不会自动停止或升级它。", "The existing service uses an unsupported launcher protocol. You can continue using it in the browser; the desktop app will not stop or upgrade it automatically."), browserUrl);
    }
    if ((!legacyVersions.has(current) && !migration) || !Number.isInteger(state.pid) || state.pid < 1
        || typeof state.nonce !== "string" || !state.nonce) {
      throw new DesktopConnectionError("legacy-unverified", t("已有服务缺少兼容标记，无法确认其启动器身份。可在浏览器继续使用；不会接管或停止该服务。", "The existing service has no compatibility marker, so its launcher identity cannot be confirmed. You can continue in the browser; the desktop app will not take over or stop the service."), browserUrl);
    }
    // Read-only wire probes; never write metadata, create a chat, or claim ownership.
    try {
      const session = await this.request(url, "/api/session");
      if (!session.headers.get("content-type")?.includes("application/json") || !sessionCompatible(await readProbe(session))) {
        await session.body?.cancel();
        throw new Error("incompatible session schema");
      }
      const events = await this.request(url, "/api/events");
      if (!events.headers.get("content-type")?.includes("application/x-ndjson")) {
        await events.body?.cancel();
        throw new Error("incompatible event transport");
      }
      const first = await readProbe(events, true);
      if (first?.type !== "snapshot" || !sessionCompatible(first.session)) throw new Error("incompatible snapshot event");
    } catch (error) {
      if (error instanceof DesktopConnectionError) throw error;
      throw new DesktopConnectionError("legacy-incompatible", t("已有旧版服务缺少兼容标记，且会话/事件协议检查未通过。可在浏览器继续使用原服务；桌面不会停止或升级它。", "The existing older service has no compatibility marker and failed the session/event protocol checks. You can continue using it in the browser; the desktop app will not stop or upgrade it."), browserUrl);
    }
    return state;
  }

  async existing() {
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      const state = await this.readState();
      if (!state) return null;
      if (state.pid && !this.isAlive(state.pid)) {
        // Do not erase a replacement instance that won the race.
        const current = await this.readState();
        if (current?.nonce === state.nonce && current?.pid === state.pid) await unlink(this.statePath).catch(error => {
          if (error.code !== "ENOENT") throw error;
        });
        continue;
      }
      if (state.starting) { await delay(100); continue; }
      let validated;
      try { validated = await this.validate(state); }
      catch (error) {
        // Say WHICH published backend failed; recovery stays display-only.
        if (error instanceof DesktopConnectionError && !error.backend) error.backend = backendIdentity(state);
        throw error;
      }
      const current = await this.readState();
      if (current?.pid !== state.pid || current?.nonce !== state.nonce || current?.url !== state.url
          || current?.version !== state.version || current?.bridgeVersion !== state.bridgeVersion
          || !this.isAlive(state.pid)) continue;
      return validated;
    }
    throw new Error(t("已有服务启动超时。请查看 pi-web/launcher.log；桌面端不会接管未知进程。", "Timed out waiting for the existing service to start. Check pi-web/launcher.log; the desktop app will not take over an unknown process."));
  }

  async connect() {
    const existing = await this.existing();
    if (existing) { this.state = existing; return existing; }
    const intent = await readHandoffIntent(this.agentDir);
    const selected = await readDesktopRelease(this.agentDir, this.bundled.version);
    if (intent) {
      localAddress(intent.url);
      if (!intent.completed && !intent.cancelled) {
        const receipt = await readHandoff(this.agentDir);
        if (receipt?.nonce !== intent.nonce || receipt.requestId !== intent.requestId || receipt.pid !== intent.pid
            || receipt.phase !== "stopped" || this.isAlive(intent.pid))
          throw new Error(t("旧启动器交接结果尚未确认，未启动第二个后台。请检查交接收据和日志；原数据已保留。", "The previous launcher handoff has not been confirmed, so a second backend was not started. Check the handoff receipt and logs; the original data is preserved."));
        if ((selected ?? this.bundled).version !== intent.version) throw new Error(t("中断交接的业务包选择已变化，未自动切换版本；请检查恢复记录", "The app package selection changed while the handoff was interrupted. The version was not switched automatically; check the recovery record."));
      }
      Object.assign(this, selected ?? this.bundled);
      const successor = await this.launch({ previousUrl: intent.url });
      if (!this.owned || successor.pid !== this.child?.pid || successor.url !== intent.url) throw new Error(t("交接恢复遇到其他启动器，未认领该实例", "Another launcher was found during handoff recovery; its instance was not claimed"));
      if (!intent.completed && !intent.cancelled) {
        await this.validateHandoffSuccessor(successor, intent.url);
        await writeHandoffIntent(this.agentDir, { ...intent, completed: true });
      }
      return successor;
    }
    Object.assign(this, selected ?? this.bundled);
    try { return await this.launch(); }
    catch (error) {
      if (!selected) throw error;
      await rollbackDesktopRelease(this.agentDir, selected.launcher);
      return this.connect(); // At most the previous selection, then the bundled fallback.
    }
  }

  async launch({ previousUrl } = {}) {
    await mkdir(dirname(this.statePath), { recursive: true });
    const fd = openSync(this.logPath, "a", 0o600);
    try {
      this.child = this.spawnProcess(this.node, [this.launcher, "__serve", this.node], {
        cwd: this.cwd, env: { ...runtimeEnvironment(this.env, this), ...(previousUrl ? { PI_WEBAPP_RESTART_PORT: localAddress(previousUrl).port, PI_WEBAPP_RESTART_TOKEN: localAddress(previousUrl).hash.slice(1) } : {}) }, detached: true,
        stdio: ["ignore", fd, fd, "ipc"], windowsHide: true,
      });
    } finally { closeSync(fd); }
    try {
      const message = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error(t("桌面后端启动超时", "Timed out starting the desktop backend"))), this.timeoutMs);
        const onMessage = value => finish(null, value);
        const onError = () => finish(new Error(t("无法启动随包 Node 运行环境", "Could not start the bundled Node runtime")));
        const onExit = () => finish(new Error(t("后端在就绪前退出，请查看启动日志", "The backend exited before becoming ready. Check the startup logs.")));
        const finish = (error, value) => {
          clearTimeout(timer);
          this.child.off("message", onMessage);
          this.child.off("error", onError);
          this.child.off("exit", onExit);
          error ? reject(error) : resolve(value);
        };
        this.child.once("message", onMessage);
        this.child.once("error", onError);
        this.child.once("exit", onExit);
      });
      if (message?.type !== "ready") {
        // Another launcher may have claimed the shared lock while we spawned.
        const winner = await this.existing();
        if (winner && winner.pid !== this.child.pid) { this.state = winner; return winner; }
        throw new Error(t("无法启动桌面后端，请查看启动日志", "Could not start the desktop backend. Check the startup logs."));
      }
      const state = await this.readState();
      if (!state || state.pid !== this.child.pid || state.url !== message.url) throw new Error(t("后端启动状态校验失败", "Backend startup state validation failed"));
      this.owned = true;
      this.state = await this.validate(state);
      return this.state;
    } catch (error) {
      // Prefer the nonce stop protocol: Windows SIGTERM would immediately kill the
      // supervisor and could leave its Pi child orphaned. Never stop another owner.
      const current = await this.readState().catch(() => null);
      if (current?.pid === this.child.pid && current?.nonce) {
        this.owned = true;
        this.state = current;
        try { await this.stop(); }
        catch { throw new Error(t("启动失败且后台清理未完成，请查看启动日志或使用 pi-webapp stop 停止该服务。", "Startup failed and backend cleanup did not complete. Check the startup logs or use pi-webapp stop to stop the service.")); }
      } else this.child.kill("SIGTERM");
      throw error;
    } finally {
      this.child.on("error", () => {});
      if (this.child.connected) this.child.disconnect();
      this.child.unref();
    }
  }

  async validateHandoffSuccessor(successor, expectedUrl) {
    const identity = await (await this.request(localAddress(successor.url), "/api/update/version")).json();
    if (!this.owned || successor.pid !== this.child?.pid || successor.url !== expectedUrl || successor.launcherHandoffProtocol !== 1 || successor.desktopReleaseChannels !== true
        || identity.launcher?.releaseChannels !== true || identity.launcher.version !== successor.version
        || identity.launcher.desktopShell?.build !== this.env.PI_WEBAPP_DESKTOP_BUILD
        || identity.launcher.desktopShell?.version !== this.env.PI_WEBAPP_DESKTOP_VERSION)
      throw new Error(t("新后台未通过原地址及通道能力验证，请保留当前窗口并检查日志", "The new backend failed validation of the original address and channel capabilities. Keep this window open and check the logs."));
  }

  /** Explicitly transfer an idle shared backend to this shell's runtime.
   * HTTP owns the chat/terminal/real-save gate; no ordinary stop or signals. */
  async handoff() {
    if (this.handingOff) throw new Error(t("启动器交接正在进行中", "A launcher handoff is already in progress"));
    this.handingOff = true;
    try {
      await this.refresh();
      const old = await this.readState();
      if (!this.state || old?.nonce !== this.state.nonce || old?.pid !== this.state.pid || old?.url !== this.state.url || !this.isAlive(old.pid)) throw new Error(t("后台归属已变化，请重新检查后再交接", "Backend ownership has changed. Check again before handing off."));
      await this.validate(old);
      if (old.runtimeKind !== "desktop" || old.launcherHandoffProtocol !== 1) throw new Error(t("旧后台尚无安全交接协议。请先切回稳定版升级业务包，再从此菜单重试；无需重复安装当前桌面，现有任务保持运行。", "The existing backend does not yet support safe handoff. Switch back to the stable channel to update the app package, then retry from this menu. You do not need to reinstall the current desktop app; existing tasks keep running."));
      // Validate the selected package BEFORE draining the current service. Never
      // silently downgrade an installed business package to this shell's bundle.
      const selected = await readDesktopRelease(this.agentDir, this.bundled.version) ?? (this.bundled.version === old.version ? this.bundled : null);
      if (!selected || selected.version !== old.version) throw new Error(t("当前业务包选择记录未通过验证或版本不一致，交接未执行；请先完成稳定版业务包更新", "The current app package selection failed validation or has a different version. Handoff was not performed; complete the stable app package update first."));
      const url = localAddress(old.url), requestId = randomUUID();
      const intent = { protocol: 1, nonce: old.nonce, requestId, pid: old.pid, version: old.version, url: old.url, phase: "requested" };
      await writeHandoffIntent(this.agentDir, intent);
      try {
        const response = await this.fetchRequest(`${url.origin}/api/desktop/handoff`, { method: "POST", redirect: "error",
          headers: { Authorization: `Bearer ${url.hash.slice(1)}`, Origin: url.origin, "Content-Type": "application/json" },
          body: JSON.stringify({ nonce: old.nonce, requestId }), signal: AbortSignal.timeout(40000) });
        if (!response.ok) {
          await writeHandoffIntent(this.agentDir, { ...intent, cancelled: true });
          const reply = await response.json().catch(() => null);
          throw new Error(typeof reply?.error === "string" ? reply.error : t("后台未接受安全交接，请先升级稳定版业务包", "The backend did not accept the safe handoff. Update the stable app package first."));
        }
        const reply = await response.json();
        if (!reply?.accepted || reply.protocol !== 1 || reply.requestId !== requestId) throw new Error(t("启动器交接响应身份不一致", "The launcher handoff response identity does not match"));
      } catch (error) {
        // A lost HTTP response is not a failed drain, nor is it permission to
        // start a second owner. Only this exact durable request can be resumed.
        const receipt = await readHandoff(this.agentDir).catch(() => null);
        if (receipt?.nonce !== old.nonce || receipt.requestId !== requestId || receipt.pid !== old.pid) throw error;
      }
      const deadline = Date.now() + this.timeoutMs;
      while (Date.now() < deadline) {
        const receipt = await readHandoff(this.agentDir);
        if (receipt?.nonce !== old.nonce || receipt.requestId !== requestId || receipt.pid !== old.pid) throw new Error(t("启动器交接收据已变化；未启动或停止其他实例", "The launcher handoff receipt changed; no other instances were started or stopped"));
        if (["failed", "refused"].includes(receipt.phase)) throw new Error(t("旧启动器未确认正常退出，交接未完成。原始数据和恢复记录已保留，请检查日志。", "The previous launcher did not confirm a normal exit, so the handoff is incomplete. The original data and recovery records are preserved; check the logs."));
        const current = await this.readState();
        if (current && (current.nonce !== old.nonce || current.pid !== old.pid)) throw new Error(t("另一启动器已接管服务，未覆盖该实例，请重新检查", "Another launcher has taken over the service. Its instance was not overwritten; check again."));
        if (receipt.phase === "stopped" && !this.isAlive(old.pid) && !current) {
          this.owned = false;
          Object.assign(this, selected);
          const successor = await this.launch({ previousUrl: old.url });
          await this.validateHandoffSuccessor(successor, old.url);
          await writeHandoffIntent(this.agentDir, { ...intent, completed: true });
          return successor;
        }
        await delay(100);
      }
      throw new Error(t("启动器交接仍在等待旧进程正常退出；未强制停止或启动第二个后台，请保留当前窗口并检查日志", "The launcher handoff is still waiting for the previous process to exit normally. Nothing was forcibly stopped and no second backend was started. Keep this window open and check the logs."));
    } finally { this.handingOff = false; }
  }

  /** Escape route owned by the shell: stop this desktop's backend, move every business-package
   * upgrade record aside (never deleted) and start the bundled version. A backend this shell does not
   * own is never stopped; the reset refuses until it has exited. */
  async resetUpgrade({ force = false } = {}) {
    if (this.handingOff) throw new Error(t("启动器交接正在进行中", "A launcher handoff is already in progress"));
    await this.refresh();
    if (this.owned) await this.stop({ force });
    const current = await this.readState();
    if (current?.pid && this.isAlive(current.pid)) throw new Error(t("另一个后台仍在运行（不是本桌面启动的）。请先运行 pi-webapp stop 停止它，再重试；未做任何更改。", "Another backend not started by this desktop is still running. Stop it with pi-webapp stop, then retry; nothing was changed."));
    const reset = await resetUpgradeState(this.agentDir);
    this.owned = false; this.state = undefined;
    Object.assign(this, this.bundled);
    return { ...reset, state: await this.connect() };
  }

  /** A supervised package restart keeps the URL/token, but changes the owner nonce.
   * Only adopt this desktop's authenticated successor; never claim a shared service.
   */
  async refresh() {
    const current = await this.readState();
    if (!current?.url || !this.isAlive(current.pid)) return;
    if (!this.state || current.url !== this.state.url || current.nonce === this.state.nonce) return;
    if (current.runtimeKind !== "desktop" || this.state.runtimeKind !== "desktop"
        || current.desktopProtocolVersion !== desktopProtocolVersion || this.state.desktopProtocolVersion !== desktopProtocolVersion) return;
    this.state = await this.validate(current);
  }

  /** force: the user confirmed skipping plugin save confirmations (unsaved plugin edits may be lost). */
  async stop({ force = false } = {}) {
    if (!this.owned || !this.state) return;
    await this.refresh();
    const current = await this.readState();
    if (current?.starting) throw new Error(t("后台状态暂不可读，未确认停止；请稍后重试，原后台已保留", "The backend state is temporarily unreadable and stopping was not confirmed. Try again later; the original backend is preserved."));
    if (current?.pid !== this.state.pid || current?.nonce !== this.state.nonce || !this.isAlive(current.pid)) return;
    await writeFile(this.stopPath, force ? `${this.state.nonce} force` : this.state.nonce, { mode: 0o600 });
    // A view flush alone can take 15s. Share the CLI's 40s drain budget and
    // distinguish an explicit refusal from a still-pending shutdown.
    const deadline = Date.now() + 40000;
    while (Date.now() < deadline) {
      const outcome = await observeStopOutcome(async () => {
        const next = await this.readState();
        if (next?.starting) return this.state; // Unknown is still pending, never a stop receipt.
        return next && this.isAlive(next.pid) ? next : null;
      }, this.stopPath, this.state.nonce);
      if (outcome === "stopped") { this.owned = false; return; }
      if (outcome === "refused") throw new Error(t("停止已取消：插件保存或释放未完成，后台及数据已保留。请保存并关闭绘图或编辑器；失联视图请先处理插件恢复记录，再重试。", "Stop cancelled: a plugin has not finished saving or releasing resources. The backend and data are preserved. Save and close drawings or editors. For disconnected views, resolve the plugin recovery records before retrying."));
      await delay(100);
    }
    throw new Error(t("停止后端超时，应用尚未退出。请查看启动日志后重试。", "Timed out stopping the backend; the app has not quit. Check the startup logs and retry."));
  }
}
