import { constants } from "node:fs";
import { access, lstat, stat } from "node:fs/promises";
import { get } from "node:http";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { parseVersion } from "../desktop/release-version.mjs";

const loopback = "127.0.0.1";
const healthTimeoutMs = 1000;
const maxHealthBytes = 16 * 1024;
const minimumNode = [22, 19, 0]; // package.json engines.node
const minimumPi = [0, 87, 1]; // launcher Pi admission floor

function validPid(pid) {
  return Number.isInteger(pid) && pid > 0 && pid <= 0x7fffffff;
}

function isAlive(pid) {
  if (!validPid(pid)) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === "EPERM"; }
}

function validHost(host) {
  return host === loopback || host === "0.0.0.0";
}

function safeVersion(value) {
  try { parseVersion(value); return value; }
  catch { return null; }
}

function localAddress(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol === "http:" && url.hostname === loopback && !url.username && !url.password && url.port !== "0") return url;
  } catch { /* Malformed or absent address. */ }
  return null;
}

async function probeHealth(url) {
  const token = url.hash.slice(1);
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(token)) return null;
  try {
    // Use the authenticated readiness route used by desktop. Connect directly
    // to loopback (no shared agent, proxy, redirects, or saved path/query).
    const response = await new Promise((resolveResponse, reject) => {
      get({ hostname: loopback, port: url.port || 80, path: "/api/update/version", agent: false,
        headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(healthTimeoutMs) }, resolveResponse)
        .on("error", reject);
    });
    if (response.statusCode !== 200) {
      response.destroy();
      return null;
    }
    // The request deadline also covers a stalled response body.
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response) {
      bytes += chunk.length;
      if (bytes > maxHealthBytes) return null;
      chunks.push(chunk);
    }
    return safeVersion(JSON.parse(Buffer.concat(chunks).toString("utf8"))?.current);
  } catch { return null; }
}

/** Print one JSON object. Accepts raw state, null, or the launcher's starting sentinel. */
export async function showStatus({ state, cliVersion }) {
  const pid = validPid(state?.pid) ? state.pid : null;
  const stopped = state == null || (pid !== null && !isAlive(pid));
  const starting = !stopped && state.starting === true;
  const address = !stopped && !starting ? localAddress(state.url) : null;
  const current = address && pid !== null ? await probeHealth(address) : null;
  console.log(JSON.stringify({
    status: stopped ? "stopped" : starting ? "starting" : current ? "healthy" : "unhealthy",
    pid: stopped ? null : pid,
    piPid: !stopped && validPid(state.piPid) ? state.piPid : null,
    listenHost: !stopped && validHost(state.listenHost) ? state.listenHost : address ? loopback : null,
    port: address ? Number(address.port || 80) : null,
    runningVersion: stopped ? null : current ?? safeVersion(state.version),
    cliVersion,
    url: address ? `${address.origin}/` : null,
  }));
}

function doctorArgs(args) {
  let host, port;
  for (let i = 0; i < args.length; i++) {
    const match = /^(--host|--port)(?:=(.*))?$/.exec(args[i]);
    if (!match) throw new Error("用法：pi-webapp doctor [--port <1–65535>] [--host <127.0.0.1|0.0.0.0>]");
    const value = match[2] ?? args[++i];
    if (match[1] === "--host") {
      if (host !== undefined) throw new Error("--host 只能指定一次");
      if (!validHost(value)) throw new Error("--host 必须是 127.0.0.1 或 0.0.0.0");
      host = value;
    } else {
      if (port !== undefined) throw new Error("--port 只能指定一次");
      if (!/^\d+$/.test(value ?? "") || Number(value) < 1 || Number(value) > 65535) throw new Error("--port 必须是 1–65535 之间的整数");
      port = Number(value);
    }
  }
  return { host: host ?? loopback, port };
}

function versionCheck(version, minimum) {
  const match = typeof version === "string" && /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  const parts = match ? match.slice(1).map(Number) : [];
  if (parts.length !== 3 || !parts.every(Number.isSafeInteger)) return [false, `版本无效（需要 ${minimum.join(".")} 或更新版本）`];
  const difference = parts.map((part, i) => part - minimum[i]).find(value => value !== 0) ?? 0;
  return [difference >= 0, `${parts.join(".")}（需要 ${minimum.join(".")} 或更新版本）`];
}

async function directoryCheck(path) {
  const target = resolve(path);
  let dir = target;
  try {
    for (;;) {
      const entry = await lstat(dir).catch(error => {
        if (error?.code === "ENOENT") return null;
        throw error;
      });
      if (entry) {
        const info = entry.isSymbolicLink() ? await stat(dir) : entry;
        if (!info.isDirectory()) return [false, `${dir} 不是目录`];
        await access(dir, constants.R_OK | constants.W_OK | constants.X_OK);
        return [true, dir === target ? `${dir} 可读写` : `${target} 不存在；上级目录 ${dir} 可读写`];
      }
      const parent = dirname(dir);
      if (parent === dir) return [false, `${target} 无法访问`];
      dir = parent;
    }
  } catch (error) { return [false, `${dir} 无法访问（${error?.code ?? "未知错误"}）`]; }
}

function bindPort(host, port) {
  return new Promise((resolveCheck, reject) => {
    const server = createServer(socket => socket.destroy());
    server.once("error", reject);
    server.listen({ host, port, exclusive: true }, () => server.close(error => error ? reject(error) : resolveCheck()));
  });
}

/** Print checks and return whether they all passed. Invalid arguments throw. */
export async function showDoctor({ args = [], readState, agentDir, probePi }) {
  const { host, port } = doctorArgs(args);
  let allGood = true;
  function report(name, ok, detail) {
    allGood &&= ok;
    console.log(`[${ok ? "OK" : "FAIL"}] ${name}: ${detail}`);
  }

  report("Node.js", ...versionCheck(process.versions.node, minimumNode));
  try {
    const version = await probePi();
    if (version == null) report("Pi", false, "未找到 Pi");
    else report("Pi", ...versionCheck(version, minimumPi));
  } catch { report("Pi", false, "无法运行 Pi --version"); }

  report("Agent directory", ...await directoryCheck(agentDir));
  report("Launcher directory", ...await directoryCheck(join(agentDir, "pi-web")));

  try {
    const state = await readState();
    if (state == null) report("Launcher state", true, "没有状态文件");
    else if (!validPid(state.pid)) report("Launcher state", false, "状态文件中的 PID 无效");
    else if (!isAlive(state.pid)) report("Launcher state", false, `状态文件已过期：PID ${state.pid} 未运行`);
    else report("Launcher state", true, `PID ${state.pid} 正在运行`);
  } catch { report("Launcher state", false, "无法读取状态文件"); }

  if (port !== undefined) {
    try {
      await bindPort(host, port);
      report("Port", true, `${host}:${port} 可绑定`);
    } catch (error) { report("Port", false, `${host}:${port} 无法绑定（${error?.code ?? "未知错误"}）`); }
  }
  return allGood;
}
