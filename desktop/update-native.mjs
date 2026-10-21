import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
export async function hasPublisherSignature(appPath, run = execute) {
  try {
    await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath], { timeout: 30000 });
    const { stderr } = await run("/usr/bin/codesign", ["-dv", "--verbose=4", appPath], { timeout: 10000 });
    return /^TeamIdentifier=[A-Z0-9]{10}$/m.test(stderr) && !/^Signature=adhoc$/m.test(stderr);
  } catch { return false; }
}

/** Squirrel.Mac does the publisher-signature check, atomic replacement and relaunch.
 * It receives only the ZIP already verified by our downloader, not an arbitrary feed.
 * Never expose this main-process service to the Web renderer or shared backend.
 */
export async function stageNativeUpdate(autoUpdater, manifest, zipPath, { timeoutMs = 120000 } = {}) {
  const size = (await stat(zipPath)).size;
  if (size !== manifest.updateAsset.bytes) throw new Error("暂存更新文件大小无效");
  const token = randomBytes(32).toString("hex");
  const sockets = new Set();
  const server = createServer((request, response) => {
    if (request.method !== "GET" || ![`/${token}/feed`, `/${token}/update.zip`].includes(request.url)) {
      response.writeHead(404).end(); return;
    }
    response.setHeader("Cache-Control", "no-store");
    if (request.url.endsWith("/feed")) {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/${token}/update.zip`,
        name: `pi ${manifest.version} desktop ${manifest.build}`, notes: "Verified desktop update" }));
    } else {
      response.writeHead(200, { "Content-Type": "application/zip", "Content-Length": size });
      const stream = createReadStream(zipPath);
      stream.on("error", () => response.destroy());
      response.on("close", () => stream.destroy());
      stream.pipe(response);
    }
  });
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.requestTimeout = 30000;
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const close = () => { for (const socket of sockets) socket.destroy(); server.close(); };
  try {
    await new Promise((resolve, reject) => {
      const finish = error => {
        clearTimeout(timer);
        autoUpdater.off("error", failed); autoUpdater.off("update-downloaded", downloaded); autoUpdater.off("update-not-available", unavailable);
        error ? reject(error) : resolve();
      };
      // Do not include raw native error messages: they can contain the private feed URL.
      const failed = () => finish(new Error("系统拒绝此桌面更新（签名、权限或暂存失败）。原应用未替换；可重启桌面后重试或手动安装。"));
      const downloaded = () => finish();
      const unavailable = () => finish(new Error("系统未接受目标更新，请重启桌面后重试"));
      const timer = setTimeout(() => finish(new Error("系统校验更新超时。原应用未替换；请重启桌面后重试。")), timeoutMs);
      autoUpdater.once("error", failed); autoUpdater.once("update-downloaded", downloaded); autoUpdater.once("update-not-available", unavailable);
      try {
        autoUpdater.setFeedURL({ url: `http://127.0.0.1:${server.address().port}/${token}/feed`, serverType: "json" });
        autoUpdater.checkForUpdates();
      } catch { failed(); }
    });
  } finally { close(); }
}

/** Never stop or upgrade a shared service. A live bundled runtime must be stopped
 * from its original entry point AFTER tasks/terminals finish, not by this updater.
 */
export async function assertDesktopInstallSafe(backend) {
  if (!backend) return;
  const state = await backend.readState();
  if (!state) return;
  if (state.starting || !Number.isInteger(state.pid) || !state.nonce) throw new Error("后台正在启动或身份未知，暂不能安装桌面更新");
  if (!backend.isAlive(state.pid)) return;
  if (backend.owned || state.runtimeKind !== "npm") throw new Error("桌面内置后台仍在运行。请先完成所有聊天任务和终端操作，再从原入口执行 pi-webapp stop；保持此桌面窗口打开，然后重新选择“检查桌面更新”安装。更新器不会停止任务或后台。");
  const next = await backend.readState();
  if (next?.pid !== state.pid || next?.nonce !== state.nonce || next?.runtimeKind !== "npm" || next?.url !== state.url) {
    throw new Error("后台在安装检查期间发生变化，请重新检查；未停止任何服务");
  }
}
