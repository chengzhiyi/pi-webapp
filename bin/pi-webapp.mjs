#!/usr/bin/env node
import { spawn as spawnNode } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync } from "node:fs";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import spawn from "cross-spawn";
import { openWebPage } from "./open-web-page.mjs";

const minimum = [0, 87, 1];
const launcher = fileURLToPath(import.meta.url);
const extension = fileURLToPath(new URL("../dist/extension.js", import.meta.url));
const agentDir = resolve((process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent")).replace(/^~(?=$|[\\/])/, homedir()));
const statePath = join(agentDir, "pi-web", "launcher.json");
const stopPath = join(agentDir, "pi-web", "launcher.stop");
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
  const result = spawn.sync("npm", ["install", "-g", "--ignore-scripts", "@earendil-works/pi-coding-agent"], { stdio: "inherit" });
  if (result.error || result.status !== 0) {
    throw new Error(`Pi 安装失败。请手动运行 npm install -g --ignore-scripts @earendil-works/pi-coding-agent${result.error ? `（${result.error.message}）` : ""}`);
  }
  const inPath = probe("pi");
  if (inPath) return inPath;
  const prefix = spawn.sync("npm", ["prefix", "-g"], { encoding: "utf8" });
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
    await lock.writeFile(JSON.stringify({ pid: process.pid, nonce, cwd: process.cwd(), starting: true }));
  } catch (error) {
    if (claimed) await unlink(statePath).catch(() => {});
    notifyParent({ type: "error", message: error?.code === "EEXIST" ? "pi-webapp 已在启动或运行" : String(error) });
    return;
  } finally { await lock?.close().catch(() => {}); }

  const child = spawn(pi, ["--mode", "rpc", "-e", extension, ...args], {
    cwd: process.cwd(), env: { ...process.env, PI_WEBAPP_AUTO_OPEN: "0" }, stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr?.pipe(process.stderr, { end: false });
  let ready = false;
  let opening = false;
  let failed = false;
  let closed = false;
  let stateWrite = Promise.resolve();
  let stopping = false;
  let buffer = "";
  let killTimer;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    child.stdin?.end();
    killTimer = setTimeout(() => child.kill("SIGTERM"), 5000);
    killTimer.unref();
  };
  const fail = (message) => {
    if (failed || ready) return;
    failed = true;
    notifyParent({ type: "error", message });
    shutdown();
  };
  const startupTimer = setTimeout(() => fail(`Pi 启动超时。日志：${logPath}`), 60000);
  const stopTimer = setInterval(async () => {
    try { if ((await readFile(stopPath, "utf8")).trim() === nonce) shutdown(); }
    catch { /* No stop request. */ }
  }, 400);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  child.stdout?.on("data", (chunk) => {
    if (ready || opening || failed) return;
    buffer += chunk.toString("utf8");
    if (buffer.length > 8 * 1024 * 1024) { fail("Pi RPC 输出超出预期大小"); return; }
    for (let index; (index = buffer.indexOf("\n")) !== -1;) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (record?.type === "response" && record.id === "list-commands") {
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
        child.stdin?.write(JSON.stringify({ id: "open-web", type: "prompt", message: `/${command.name}` }) + "\n");
        continue;
      }
      if (record?.type === "response" && record.id === "open-web" && record.success === false) {
        fail(`Pi 拒绝打开网页：${record.error ?? "未知错误"}`);
        return;
      }
      if (record?.type !== "extension_ui_request" || record.method !== "notify" || typeof record.message !== "string" || !record.message.startsWith("pi-webapp: ")) continue;
      let url;
      try { url = new URL(record.message.slice("pi-webapp: ".length)); }
      catch { continue; }
      if (url.hostname !== "127.0.0.1" || !url.hash) continue;
      opening = true;
      stateWrite = saveState({ pid: process.pid, piPid: child.pid, nonce, cwd: process.cwd(), url: url.href })
        .then(() => {
          if (closed || failed) return;
          ready = true;
          clearTimeout(startupTimer);
          notifyParent({ type: "ready", pid: process.pid, url: url.href });
        })
        .catch((error) => fail(`无法保存启动状态：${error.message}`));
      return;
    }
  });
  child.stdin?.on("error", (error) => fail(`无法向 Pi 发送启动命令：${error.message}`));
  child.stdin?.write(JSON.stringify({ id: "list-commands", type: "get_commands" }) + "\n");
  await new Promise((resolveExit) => {
    child.once("error", (error) => { fail(`无法启动 Pi：${error.message}`); resolveExit(); });
    child.once("close", (code) => {
      closed = true;
      if (!ready) fail(`Pi 提前退出（代码 ${code ?? "未知"}）。日志：${logPath}`);
      resolveExit();
    });
  });
  await stateWrite;
  clearTimeout(startupTimer);
  clearInterval(stopTimer);
  clearTimeout(killTimer);
  try { if ((await readFile(stopPath, "utf8")).trim() === nonce) await unlink(stopPath); } catch { /* Already removed. */ }
  if (claimed) {
    try { if (JSON.parse(await readFile(statePath, "utf8")).nonce === nonce) await unlink(statePath); }
    catch { /* Already removed. */ }
  }
}

async function start(args) {
  const existing = await activeState();
  if (existing) {
    console.log(existing.url ? `pi-webapp 已在后台运行：${existing.url}` : "pi-webapp 正在启动");
    if (existing.url) await openPageIfLocal(existing.url);
    return;
  }
  const nodeVersion = versionParts(process.versions.node);
  if (!nodeVersion || !compatible(nodeVersion, [22, 19, 0])) throw new Error("需要 Node.js 22.19 或更新版本。");
  if (!existsSync(extension)) throw new Error("找不到构建后的扩展。请先运行 npm run build。");
  if (args.some((arg) => ["--mode", "--print", "-p"].includes(arg))) throw new Error("后台启动不支持覆盖 Pi 的运行模式");
  const pi = probe("pi") ?? installPi();
  await mkdir(dirname(statePath), { recursive: true });
  const logFd = openSync(logPath, "a", 0o600);
  let worker;
  try {
    worker = spawnNode(process.execPath, [launcher, "__serve", pi, ...args], {
      detached: true, cwd: process.cwd(), env: process.env, stdio: ["ignore", logFd, logFd, "ipc"],
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
  for (let attempt = 0; attempt < 120; attempt++) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    const current = await activeState();
    if (!current || current.nonce !== state.nonce) { console.log("pi-webapp 已停止"); return; }
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
