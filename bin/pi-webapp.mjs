#!/usr/bin/env node
import { spawn as spawnNode } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, watch } from "node:fs";
import { mkdir, open, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import spawn from "cross-spawn";
import { openWebPage } from "./open-web-page.mjs";
import { npmCommand } from "./npm-command.mjs";
import { packagePiCli } from "./package-pi-cli.mjs";
import { observeStopOutcome } from "./launcher-state.mjs";
import { compareVersions, parseVersion } from "../desktop/release-version.mjs";
import { desktopProtocolVersion, desktopUpdatePath, readDesktopRelease, rollbackDesktopRelease } from "../desktop/managed-release.mjs";

import { launcherHandoffProtocol, readHandoff, writeHandoff } from "../desktop/launcher-handoff.mjs";

const minimum = [0, 87, 1];
const packageVersion = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version;
const runtimeKind = process.env.PI_WEBAPP_RUNTIME === "desktop" ? "desktop" : "npm";
const desktopPackages = runtimeKind === "desktop" && process.env.PI_WEBAPP_DESKTOP_PACKAGE_UPDATES === "1";
const runtimeInfo = { version: packageVersion, bridgeVersion: 1, runtimeKind, desktopProtocolVersion, launcherHandoffProtocol, launcherVersion: packageVersion, desktopShell: { version: process.env.PI_WEBAPP_DESKTOP_VERSION ?? "unknown", build: process.env.PI_WEBAPP_DESKTOP_BUILD ?? "unknown" }, desktopReleaseChannels: process.env.PI_WEBAPP_DESKTOP_RELEASE_CHANNELS === "1" };
const launcher = fileURLToPath(import.meta.url);
const extension = fileURLToPath(new URL("../dist/extension.js", import.meta.url));
const agentDir = resolve((process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent")).replace(/^~(?=$|[\\/])/, homedir()));
const statePath = join(agentDir, "pi-web", "launcher.json");
const stopPath = join(agentDir, "pi-web", "launcher.stop");
const restartPath = join(agentDir, "pi-web", "launcher.restart");
const updatePath = desktopPackages ? desktopUpdatePath(agentDir) : join(agentDir, "pi-web", "update.json");
const logPath = join(agentDir, "pi-web", "launcher.log");

function versionParts(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
  return match ? match.slice(1).map(Number) : null;
}

function compatible(parts, required) {
  for (let i = 0; i < 3; i++) {
    if (parts[i] !== required[i]) return parts[i] > required[i];
  }
  return true;
}

function probe(command) {
  const result = spawn.sync(command, ["--version"], { encoding: "utf8" });
  if (result.error?.code === "ENOENT") return null;
  if (result.error || result.status !== 0) {
    throw new Error(`无法运行 Pi：${result.error?.message || result.stderr?.trim() || command}`);
  }
  const version = result.stdout.trim();
  const parts = versionParts(version);
  if (!parts || !compatible(parts, minimum)) {
    throw new Error(`Pi 版本 ${version || "未知"} 不受支持，需要 0.87.1 或更新版本。请更新 Pi 后重试。`);
  }
  return command;
}

function installPi() {
  console.error("未找到 Pi，正在通过 npm 安装 @earendil-works/pi-coding-agent …");
  const install = npmCommand(["install", "-g", "--ignore-scripts", "@earendil-works/pi-coding-agent"]);
  const result = spawn.sync(install.file, install.args, { stdio: "inherit", windowsHide: true });
  if (result.error || result.status !== 0) {
    throw new Error(`Pi 安装失败。请手动运行 npm install -g --ignore-scripts @earendil-works/pi-coding-agent${result.error ? `（${result.error.message}）` : ""}`);
  }
  const inPath = probe("pi");
  if (inPath) return inPath;
  const prefixCommand = npmCommand(["prefix", "-g"]);
  const prefix = spawn.sync(prefixCommand.file, prefixCommand.args, { encoding: "utf8", windowsHide: true });
  if (prefix.status === 0) {
    const installed = process.platform === "win32" ? join(prefix.stdout.trim(), "pi.cmd") : join(prefix.stdout.trim(), "bin", "pi");
    if (existsSync(installed)) return probe(installed);
  }
  throw new Error("Pi 已安装，但找不到 pi 命令。请将 npm 全局可执行目录加入 PATH 后重试。");
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === "EPERM"; }
}

async function activeState() {
  let state;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { state = JSON.parse(await readFile(statePath, "utf8")); break; }
    catch (error) {
      if (error?.code === "ENOENT") return null;
      if (!(error instanceof SyntaxError)) throw error;
      if (attempt < 2) { await new Promise((resolveWait) => setTimeout(resolveWait, 50)); continue; }
      const age = Date.now() - (await stat(statePath)).mtimeMs;
      if (age < 5000) return { starting: true };
      await unlink(statePath).catch(() => {});
      return null;
    }
  }
  if (alive(state?.pid)) return state;
  await unlink(statePath).catch(() => {});
  return null;
}

async function saveState(state) {
  const temporary = `${statePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
    await rename(temporary, statePath);
  } finally { await unlink(temporary).catch(() => {}); }
}

function notifyParent(message) {
  if (process.connected) process.send?.(message);
}

async function serve(pi, args) {
  const nonce = randomUUID();
  await mkdir(dirname(statePath), { recursive: true });
  let claimed = false;
  let lock;
  try {
    lock = await open(statePath, "wx", 0o600);
    claimed = true;
    await lock.writeFile(JSON.stringify({ pid: process.pid, nonce, cwd: process.cwd(), starting: true, ...runtimeInfo }));
  } catch (error) {
    if (claimed) await unlink(statePath).catch(() => {});
    notifyParent({ type: "error", message: error?.code === "EEXIST" ? "pi-webapp 已在启动或运行" : String(error) });
    return;
  } finally { await lock?.close().catch(() => {}); }

  const pluginRoots = (process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS ?? "").split(delimiter).filter(Boolean).map((root) => resolve(root));
  const piPrefix = process.env.PI_WEBAPP_PI_CLI ? [resolve(process.env.PI_WEBAPP_PI_CLI)] : [];
  const child = spawn(pi, [...piPrefix, "--mode", "rpc", "-e", extension, ...pluginRoots.flatMap((root) => ["-e", root]), ...args], {
    cwd: process.cwd(), env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${JSON.stringify(new URL("./model-network-bootstrap.mjs", import.meta.url).href)}`.trim(), PI_WEBAPP_AUTO_OPEN: "0", PI_WEBAPP_LAUNCHER_NONCE: nonce, PI_WEBAPP_LAUNCHER_HANDOFF_PROTOCOL: "1", PI_WEBAPP_LAUNCHER_VERSION: packageVersion }, stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr?.pipe(process.stderr, { end: false });
  let ready = false;
  let opening = false;
  let failed = false;
  let closed = false;
  let stateWrite = Promise.resolve();
  let stopping = false;
  let restartRequest = null;
  let handoffRequest = null;
  let runningUrl = null;
  let buffer = "";
  let killTimer;
  let stopReason;
  let forceStopRequested = false;
  let stopCommand;
  let stopPreflightTimer;
  let stopPreflightId;
  let stopCheckRunning = false;
  let stopEpoch = 0;
  const instanceId = randomUUID();
  const startedAt = performance.now();
  const lifecycle = (event, fields = {}) => {
    try {
      console.error(JSON.stringify({ timestamp: new Date().toISOString(), event,
        level: event === "pi_process_exit" && (!stopping || failed) ? "error" : "info",
        instanceId, pid: process.pid, piPid: child.pid, uptimeMs: Math.round(performance.now() - startedAt), ...fields }));
    } catch { /* Diagnostics must not interrupt process supervision. */ }
  };
  // Opt-in fixture diagnostics: fixed milestones only, never RPC content or URLs.
  const startupStage = stage => { if (process.env.PI_WEBAPP_STARTUP_TRACE === "1") lifecycle("launcher_startup_stage", { stage }); };
  let sawStdout = false;
  const devWatchers = [];
  let devReloadTimer;
  let devReloadCount = 0;
  let devReloadCommand;
  const finishShutdown = (reason) => {
    child.stdin?.end();
    // A handoff is not permission to kill a stalled process. The new desktop
    // must wait for this supervisor and its child to exit naturally.
    if (handoffRequest) return;
    killTimer = setTimeout(() => {
      forceStopRequested = true;
      lifecycle("pi_force_stop", { reason, signal: "SIGTERM" });
      child.kill("SIGTERM");
    }, 5000);
    killTimer.unref();
  };
  const refuseShutdown = () => {
    clearTimeout(stopPreflightTimer);
    stopPreflightId = undefined;
    lifecycle("launcher_stop_refused", { reason: stopReason });
    restartRequest = null;
    // Keep the gate closed until the rejected request is gone. Otherwise the
    // interval can read that same nonce again and launch an unsolicited drain,
    // racing the caller's explicit retry (or leaving an idle host draining).
    void readFile(stopPath, "utf8").then(value => value.trim() === nonce ? unlink(stopPath) : undefined)
      .catch(() => {}).finally(() => { stopping = false; });
  };
  const shutdown = (reason) => {
    if (stopping) return;
    stopping = true;
    stopEpoch++;
    stopReason = reason;
    lifecycle("launcher_stop_requested", { reason });
    // RPC EOF can exit even when an extension's shutdown handler fails. Drain
    // while the transport is alive and require an explicit successful response.
    if (ready && stopCommand) {
      stopPreflightId = `prepare-stop-${randomUUID()}`;
      // A slow admitted batch may still be draining. A timeout is not proof it
      // stopped: keep its receipt live and never launch a second teardown.
      stopPreflightTimer = setTimeout(() => lifecycle("launcher_stop_pending", { reason }), 35_000);
      child.stdin?.write(JSON.stringify({ id: stopPreflightId, type: "prompt", message: `/${stopCommand} ${stopPreflightId}` }) + "\n");
    } else finishShutdown(reason); // Legacy runtimes have no drain command.
  };
  const fail = (message) => {
    if (failed || ready) return;
    failed = true;
    notifyParent({ type: "error", message });
    shutdown("startup_failure");
  };
  const startupTimer = setTimeout(() => fail(`Pi 启动超时。日志：${logPath}`), 60000);
  const stopTimer = setInterval(async () => {
    if (stopping || stopCheckRunning) return;
    stopCheckRunning = true;
    const epoch = stopEpoch;
    try {
      try {
        const request = (await readFile(stopPath, "utf8")).trim();
        if (epoch !== stopEpoch || stopping) return;
        if (request === nonce) shutdown("stop_request");
      } catch { /* No stop request. */ }
      if (stopping || epoch !== stopEpoch) return;
      if (runtimeKind === "desktop") {
        const handoff = await readHandoff(agentDir).catch(() => null);
        if (handoff?.nonce === nonce && handoff.pid === process.pid && handoff.phase === "requested") {
          // The authenticated HTTP gate already froze admission and received the
          // real plugin checkpoint/worker drain before publishing this request.
          try { await writeHandoff(agentDir, { ...handoff, phase: "draining" }); }
          catch { lifecycle("launcher_handoff_receipt_failed"); return; }
          handoffRequest = handoff;
          stopping = true; stopEpoch++; stopReason = "launcher_handoff";
          lifecycle("launcher_handoff_draining"); finishShutdown(stopReason); return;
        }
      }
      try {
        const request = JSON.parse(await readFile(restartPath, "utf8"));
        const prepared = JSON.parse(await readFile(updatePath, "utf8"));
        const selected = desktopPackages ? await readDesktopRelease(agentDir, packageVersion) : prepared;
        if (stopping || epoch !== stopEpoch) return;
        if ((runtimeKind !== "desktop" || desktopPackages) && request.nonce === nonce && request.launcher === selected?.launcher && existsSync(request.launcher)) {
          restartRequest = request;
          shutdown("restart_request");
        }
      } catch { /* No valid restart request. */ }
    } finally { stopCheckRunning = false; }
  }, 400);
  process.on("SIGTERM", () => shutdown("signal_sigterm"));
  process.on("SIGINT", () => shutdown("signal_sigint"));
  child.stdout?.on("data", (chunk) => {
    if (failed) return;
    if (!sawStdout) { sawStdout = true; startupStage("first-rpc-output"); }
    buffer += chunk.toString("utf8");
    if (buffer.length > 8 * 1024 * 1024) { fail("Pi RPC 输出超出预期大小"); return; }
    for (let index; (index = buffer.indexOf("\n")) !== -1;) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (record?.type === "extension_ui_request" && record.method === "notify" && typeof record.message === "string" && record.message.startsWith("pi-webapp-stop: ")) {
        let receipt;
        try { receipt = JSON.parse(record.message.slice("pi-webapp-stop: ".length)); } catch { continue; }
        if (!stopping || receipt.id !== stopPreflightId) continue;
        stopPreflightId = undefined;
        clearTimeout(stopPreflightTimer);
        if (receipt.ok === true) finishShutdown(stopReason);
        else refuseShutdown();
        continue;
      }
      if (record?.type === "response" && record.id === stopPreflightId && record.success === false) {
        refuseShutdown();
        continue;
      }
      if (record?.type === "response" && /^dev-reload-\d+$/.test(record.id ?? "")) {
        console.error(`pi-webapp: ${record.id} /${devReloadCommand ?? "web-dev-reload"}: ${record.success === true ? "reloaded" : `failed: ${record.error ?? "Unknown RPC error"}`}`);
        continue;
      }
      if (ready || opening) continue;
      if (record?.type === "response" && record.id === "list-commands") {
        startupStage("command-list-response");
        if (record.success !== true || !Array.isArray(record.data?.commands)) {
          fail("无法读取 Pi 扩展命令列表");
          return;
        }
        const command = record.data.commands.find((item) => item?.source === "extension"
          && item.sourceInfo?.path === extension && /^web(?::\d+)?$/.test(item.name));
        if (!command) {
          fail("Pi 没有加载当前项目的 Web 扩展");
          return;
        }
        stopCommand = record.data.commands.find((item) => item?.source === "extension"
          && item.sourceInfo?.path === extension && /^web-prepare-stop(?::\d+)?$/.test(item.name))?.name;
        devReloadCommand = record.data.commands.find((item) => item?.source === "extension"
          && item.sourceInfo?.path === extension && /^web-dev-reload(?::\d+)?$/.test(item.name))?.name;
        startupStage("opening-web-command");
        child.stdin?.write(JSON.stringify({ id: "open-web", type: "prompt", message: `/${command.name}` }) + "\n");
        continue;
      }
      if (record?.type === "response" && record.id === "open-web" && record.success === false) {
        fail(`Pi 拒绝打开网页：${record.error ?? "未知错误"}`);
        return;
      }
      if (record?.type !== "extension_ui_request" || record.method !== "notify" || typeof record.message !== "string" || !record.message.startsWith("pi-webapp: ")) continue;
      startupStage("web-ready-notification");
      let url;
      try { url = new URL(record.message.slice("pi-webapp: ".length)); }
      catch { continue; }
      if (url.hostname !== "127.0.0.1" || !url.hash) continue;
      runningUrl = url.href;
      opening = true;
      stateWrite = saveState({ pid: process.pid, piPid: child.pid, nonce, cwd: process.cwd(), url: url.href, ...runtimeInfo })
        .then(() => {
          if (closed || failed) return;
          ready = true;
          clearTimeout(startupTimer);
          lifecycle("launcher_ready", { port: Number(url.port) });
          notifyParent({ type: "ready", pid: process.pid, url: url.href });
          for (const root of pluginRoots) {
            try {
              devWatchers.push(watch(join(root, "dist"), (_event, file) => {
                if (String(file ?? "") !== "extension.js") return;
                clearTimeout(devReloadTimer);
                devReloadTimer = setTimeout(() => {
                  if (closed || stopping) return;
                  if (!devReloadCommand) { console.error("pi-webapp: development reload unavailable: local extension command not found"); return; }
                  child.stdin?.write(JSON.stringify({ id: `dev-reload-${++devReloadCount}`, type: "prompt", message: `/${devReloadCommand}` }) + "\n");
                }, 250);
              }));
            } catch (error) { console.error(`pi-webapp: cannot watch plugin ${root}: ${error}`); }
          }
        })
        .catch((error) => fail(`无法保存启动状态：${error.message}`));
      return;
    }
  });
  child.stdin?.on("error", (error) => fail(`无法向 Pi 发送启动命令：${error.message}`));
  startupStage("waiting-command-list");
  child.stdin?.write(JSON.stringify({ id: "list-commands", type: "get_commands" }) + "\n");
  await new Promise((resolveExit) => {
    child.once("error", (error) => { fail(`无法启动 Pi：${error.message}`); resolveExit(); });
    child.once("close", (code, signal) => {
      closed = true;
      lifecycle("pi_process_exit", { ready, exitCode: code, signal,
        reason: stopReason ?? (ready ? "unexpected_exit" : "startup_failure"), forceStopRequested,
        port: runningUrl ? Number(new URL(runningUrl).port) : null });
      if (!ready) fail(`Pi 提前退出（代码 ${code ?? "未知"}）。日志：${logPath}`);
      resolveExit();
    });
  });
  await stateWrite;
  if (handoffRequest) await writeHandoff(agentDir, { ...handoffRequest, phase: failed || child.exitCode !== 0 ? "failed" : "stopped" });
  clearTimeout(startupTimer);
  clearTimeout(stopPreflightTimer);
  clearTimeout(devReloadTimer);
  for (const watcher of devWatchers) watcher.close();
  clearInterval(stopTimer);
  clearTimeout(killTimer);
  if (claimed) {
    try { if (JSON.parse(await readFile(statePath, "utf8")).nonce === nonce) await unlink(statePath); }
    catch { /* Already removed. */ }
  }
  try { if ((await readFile(stopPath, "utf8")).trim() === nonce) await unlink(stopPath); } catch { /* Already removed. */ }
  if (restartRequest && runningUrl) {
    await unlink(restartPath).catch(() => {});
    const oldUrl = new URL(runningUrl);
    const fd = openSync(logPath, "a", 0o600);
    const restartEnv = { ...process.env, PI_WEBAPP_AUTO_OPEN: "0", PI_WEBAPP_RESTART_PORT: oldUrl.port, PI_WEBAPP_RESTART_TOKEN: oldUrl.hash.slice(1) };
    try {
      const runLauncher = async (path) => {
        const selected = desktopPackages ? await readDesktopRelease(agentDir, packageVersion) : null;
        const env = selected?.launcher === path ? { ...restartEnv, PI_WEBAPP_PI_CLI: selected.piCli } : restartEnv;
        return new Promise((resolveExit) => {
          const next = spawnNode(process.execPath, [path, "start", ...args], { cwd: process.cwd(), env, stdio: ["ignore", fd, fd] });
          next.once("error", () => resolveExit(1));
          next.once("exit", (code) => resolveExit(code ?? 1));
        });
      };
      if (await runLauncher(restartRequest.launcher) !== 0) {
        await clearManagedLauncher(restartRequest.launcher);
        console.error("pi-webapp: 新版启动失败，正在恢复旧版服务");
        if (await runLauncher(launcher) !== 0) console.error(`pi-webapp: 旧版恢复失败。日志：${logPath}`);
      }
    } finally { closeSync(fd); }
  }
}

async function clearManagedLauncher(path) {
  if (desktopPackages) { await rollbackDesktopRelease(agentDir, path); return; }
  try {
    const selected = JSON.parse(await readFile(updatePath, "utf8"));
    if (selected.launcher === path) {
      if (selected.previous) {
        const temporary = `${updatePath}.${randomUUID()}.tmp`;
        await writeFile(temporary, JSON.stringify(selected.previous), { mode: 0o600 });
        await rename(temporary, updatePath);
      } else await unlink(updatePath);
    }
  } catch { /* No matching managed release. */ }
}

async function managedLauncher() {
  if (runtimeKind === "desktop") {
    if (!desktopPackages) return null;
    const selected = await readDesktopRelease(agentDir, packageVersion);
    return selected && await realpath(selected.launcher) !== await realpath(launcher) ? selected.launcher : null;
  }
  try {
    if (existsSync(fileURLToPath(new URL("../.git", import.meta.url)))) return null;
    const update = JSON.parse(await readFile(updatePath, "utf8"));
    const current = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    parseVersion(update.version); parseVersion(current.version);
    if (compareVersions(update.version, current.version) < 0 && !(update.allowDowngrade === true && update.baseVersion === current.version)) return null;
    if (update.version === current.version || !existsSync(update.launcher)) return null;
    return update.launcher;
  } catch { return null; }
}

async function start(args) {
  const existing = await activeState();
  if (existing) {
    console.log(existing.url ? `pi-webapp 已在后台运行：${existing.url}` : "pi-webapp 正在启动");
    if (existing.url) await openPageIfLocal(existing.url);
    return;
  }
  const managed = await managedLauncher();
  if (managed) {
    const selected = desktopPackages ? await readDesktopRelease(agentDir, packageVersion) : null;
    const env = selected?.launcher === managed ? { ...process.env, PI_WEBAPP_PI_CLI: selected.piCli } : process.env;
    const next = spawnNode(process.execPath, [managed, "start", ...args], { cwd: process.cwd(), env, stdio: "inherit" });
    const code = await new Promise((resolveExit, rejectExit) => { next.once("error", rejectExit); next.once("exit", (status) => resolveExit(status)); });
    if (code !== 0) {
      await clearManagedLauncher(managed);
      console.error(`pi-webapp: 新版启动失败（代码 ${code ?? "未知"}），正在恢复当前安装`);
      await start(args);
    }
    return;
  }
  const nodeVersion = versionParts(process.versions.node);
  if (!nodeVersion || !compatible(nodeVersion, [22, 19, 0])) throw new Error("需要 Node.js 22.19 或更新版本。");
  if (!existsSync(extension)) throw new Error("找不到构建后的扩展。请先运行 npm run build。");
  if (args.some((arg) => ["--mode", "--print", "-p"].includes(arg))) throw new Error("后台启动不支持覆盖 Pi 的运行模式");
  const piCli = await packagePiCli(dirname(dirname(launcher))) ?? process.env.PI_WEBAPP_PI_CLI;
  const pi = piCli ? process.execPath : probe("pi") ?? installPi();
  await mkdir(dirname(statePath), { recursive: true });
  const logFd = openSync(logPath, "a", 0o600);
  let worker;
  try {
    worker = spawnNode(process.execPath, [launcher, "__serve", pi, ...args], {
      detached: true, cwd: process.cwd(), env: { ...process.env, ...(piCli ? { PI_WEBAPP_PI_CLI: piCli } : {}) }, stdio: ["ignore", logFd, logFd, "ipc"],
    });
  } finally { closeSync(logFd); }
  let ready;
  try {
    ready = await new Promise((resolveReady, rejectReady) => {
      const timer = setTimeout(() => rejectReady(new Error(`后台启动超时。日志：${logPath}`)), 65000);
      worker.once("message", (message) => {
        clearTimeout(timer);
        if (message?.type === "ready") resolveReady(message);
        else rejectReady(new Error(message?.message ?? "后台启动失败"));
      });
      worker.once("error", rejectReady);
      worker.once("exit", (code) => rejectReady(new Error(`后台进程退出（代码 ${code ?? "未知"}）。日志：${logPath}`)));
    });
  } finally {
    if (worker.connected) worker.disconnect();
    worker.unref();
  }
  console.log(`pi-webapp 已在后台运行（PID ${ready.pid}）：${ready.url}`);
  console.log("停止服务：pi-webapp stop（源码目录中可运行 npm run stop）");
  await openPageIfLocal(ready.url);
}

async function openPageIfLocal(url) {
  if (process.env.PI_WEBAPP_AUTO_OPEN === "0") return;
  try {
    if (!await openWebPage(url)) console.log("当前没有本地图形桌面，请手动打开上方地址。");
  } catch {
    console.error("无法自动打开浏览器，请手动打开上方地址。");
  }
}

async function stop() {
  const state = await activeState();
  if (!state) { console.log("pi-webapp 未运行"); return; }
  if (!state.nonce) throw new Error("pi-webapp 正在启动，请稍后再停止");
  await writeFile(stopPath, state.nonce, { mode: 0o600 });
  for (let attempt = 0; attempt < 400; attempt++) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    const outcome = await observeStopOutcome(activeState, stopPath, state.nonce);
    if (outcome === "stopped") { console.log("pi-webapp 已停止"); return; }
    if (outcome === "refused") throw new Error("停止已取消：插件保存或释放未完成，服务及数据已保留。请处理插件诊断后重试。");
  }
  throw new Error(`停止超时。后台进程 PID：${state.pid}；日志：${logPath}`);
}

async function main() {
  const [argument, ...rest] = process.argv.slice(2);
  if (argument === "__serve") { await serve(rest[0], rest.slice(1)); return; }
  if (argument === "stop" || argument === "status") {
    if (rest.length) throw new Error(`用法：pi-webapp ${argument}`);
    if (argument === "stop") await stop();
    else {
      const state = await activeState();
      console.log(state ? `pi-webapp ${state.url ? `正在运行：${state.url}` : "正在启动"}` : "pi-webapp 未运行");
    }
    return;
  }
  if (argument === "--help" || argument === "-h") { console.log("用法：pi-webapp [start|status|stop] [Pi 参数]"); return; }
  if (argument && argument !== "start" && !argument.startsWith("-")) throw new Error("用法：pi-webapp [start|status|stop] [Pi 参数]");
  await start(argument === "start" || !argument ? rest : [argument, ...rest]);
}

main().catch((error) => {
  console.error(`pi-webapp: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
