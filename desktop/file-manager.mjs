import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs";
import { lstat } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { promisify } from "node:util";
import { localAddress, sameDocument } from "./backend.mjs";

const canonicalPath = promisify(realpath.native); // Resolve junctions and get canonical casing on Windows.
const exec = promisify(execFile);
const failed = () => ({ ok: false, reason: "failed" });
const notFound = () => ({ ok: false, reason: "not-found" });
const validId = id => typeof id === "string" && id.length > 0 && id.length <= 256;
const unsafeWindowsName = name => /[<>:"|?*\x00-\x1f]|[. ]$|\.\{[0-9a-f-]+\}$/i.test(name)
  || /^(?:CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³]) *(?:\.|$)/i.test(name);

function parseTarget(input, platform) {
  if (!input || typeof input !== "object") return;
  const { sessionId, workspaceId, path, kind } = input;
  if (kind !== "file" && kind !== "directory") return;
  if (typeof path !== "string" || path.length > 4096 || /[\\\0]/.test(path) || /^[a-z]:/i.test(path)) return;
  const segments = path === "" ? [] : path.split("/");
  if (segments.some(part => !part || part === "." || part === ".." || (platform === "win32" && unsafeWindowsName(part)))) return;
  if (!segments.length && kind !== "directory") return;
  if (validId(sessionId) && !Object.hasOwn(input, "workspaceId")) return { sessionId, segments, kind };
  if (validId(workspaceId) && !Object.hasOwn(input, "sessionId") && !segments.length) return { workspaceId, segments, kind };
}

function localAbsolute(path, platform) {
  if (typeof path !== "string" || path.includes("\0")) return false;
  if (platform === "darwin") return posix.isAbsolute(path);
  // Only ordinary drive paths; never pass network, volume namespace or device paths to the shell.
  return /^[a-z]:[\\/]/i.test(path) && path.slice(3).split(/[\\/]/).filter(Boolean).every(part => !unsafeWindowsName(part));
}

async function lookupRoot(backendUrl, target, fetcher) {
  const backend = localAddress(backendUrl);
  const endpoint = target.sessionId ? "/api/session" : "/api/workspaces";
  const response = await fetcher(new URL(endpoint, backend), {
    method: "GET", headers: { Authorization: `Bearer ${backend.hash.slice(1)}` },
    redirect: "error", signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("Backend lookup failed");
  const data = await response.json();
  if (target.sessionId) {
    if (typeof data?.sessionId !== "string" || typeof data.cwd !== "string") throw new Error("Invalid session snapshot");
    return data.sessionId === target.sessionId ? data.cwd : undefined;
  }
  if (!Array.isArray(data?.items)) throw new Error("Invalid workspace listing");
  const item = data.items.find(row => row?.id === target.workspaceId);
  return item?.available === false ? undefined : item?.path;
}

async function isMacFolder(path) {
  // Electron openPath can launch packages (such as .app) even though they are
  // directories on disk. Ask Launch Services before handing a path to openPath.
  // The path is a positional argument, never interpolated into script or shell syntax.
  const { stdout } = await exec("/usr/bin/osascript", ["-l", "JavaScript", "-e",
    'ObjC.import("AppKit"); function run(argv) { return $.NSWorkspace.sharedWorkspace.isFilePackageAtPath(argv[0]) ? "package" : "folder"; }',
    "--", path], { timeout: 3000 });
  return stdout.trim() === "folder";
}

async function systemApps(platform) {
  if (platform === "darwin") {
    const { listMacApps, openMacApp } = await import("./open-with-macos.mjs");
    return { list: listMacApps, open: openMacApp };
  }
  const { listWindowsApps, openWindowsApp } = await import("./open-with-windows.mjs");
  return { list: listWindowsApps, open: openWindowsApp };
}

const publicAppId = id => createHash("sha256").update(id).digest("base64url");
const directLaunchType = /\.(?:app|application|bat|cmd|com|command|cpl|desktop|dll|exe|gadget|hta|inf|ins|isp|jar|jse|lnk|msc|msi|msp|pif|pkg|ps1|reg|scf|scr|shb|sct|url|vb[es]|vxd|webloc|ws[cfh])$/i;
function appChoices(discovered) {
  const unique = new Map();
  for (const app of discovered) {
    if (typeof app?.id !== "string" || !app.id || app.id.length > 4096 || typeof app.name !== "string") continue;
    const name = app.name.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 120);
    const id = publicAppId(app.id);
    if (!name || unique.has(id)) continue;
    const icon = typeof app.icon === "string" && app.icon.length <= 24_000 && /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(app.icon) ? app.icon : undefined;
    unique.set(id, { nativeId: app.id, item: { id, name, ...(icon && { icon }), ...(app.isDefault === true && { isDefault: true }) } });
  }
  return [...unique.values()].sort((a, b) => Number(!!b.item.isDefault) - Number(!!a.item.isDefault) || a.item.name.localeCompare(b.item.name)).slice(0, 16);
}

export function installFileManagerIpc({ ipcMain, shell, getContents, getBackendUrl, platform = process.platform, fetcher = fetch,
  realpath = canonicalPath, inspect = lstat, macFolder = isMacFolder, getApps = systemApps }) {
  if (platform !== "darwin" && platform !== "win32") return;
  const pathApi = platform === "win32" ? win32 : posix;
  const handle = operation => async (event, input, appId) => {
    try {
      const contents = getContents();
      const backendUrl = getBackendUrl();
      const frame = event.senderFrame;
      const trusted = () => contents && contents === getContents() && !contents.isDestroyed() && event.sender === contents
        && frame && frame === event.senderFrame && frame === contents.mainFrame && backendUrl && backendUrl === getBackendUrl()
        && sameDocument(frame.url, backendUrl);
      if (!trusted()) return failed();
      const target = parseTarget(input, platform);
      if (!target || (operation !== "show" && !target.sessionId)) return failed();
      if (operation === "open" && (typeof appId !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(appId))) return failed();
      const listed = await lookupRoot(backendUrl, target, fetcher);
      if (listed === undefined) return notFound();
      if (!localAbsolute(listed, platform)) return failed();
      const root = await realpath(listed);
      if (!localAbsolute(root, platform) || !(await inspect(root)).isDirectory()) return failed();
      const path = target.segments.length ? await realpath(pathApi.join(root, ...target.segments)) : root;
      // Match a full component, without case-folding Windows paths (NTFS can
      // have case-sensitive directories). Both paths came from native realpath.
      const prefix = root.endsWith(pathApi.sep) ? root : root + pathApi.sep;
      if (!localAbsolute(path, platform) || (path !== root && !path.startsWith(prefix))) return failed();
      const info = await inspect(path);
      if (target.kind === "directory" ? !info.isDirectory() : !info.isFile()) return notFound();
      if (target.kind === "directory" && platform === "darwin") {
        if (!await macFolder(path) || await realpath(path) !== path) return failed();
        // Package detection is asynchronous. Do not open a replacement item.
        const current = await inspect(path);
        if (!current.isDirectory() || current.dev !== info.dev || current.ino !== info.ino) return failed();
      }
      if (!trusted()) return failed();
      if (operation !== "show") {
        // Never use shell.openPath on files, and don't offer executable/shortcut types to handlers.
        if (target.kind === "file" && directLaunchType.test(path)) return operation === "list" ? { ok: true, apps: [] } : failed();
        const system = await getApps(platform);
        const choices = appChoices(await system.list(path, target.kind));
        if (!trusted()) return failed();
        if (operation === "list") return { ok: true, apps: choices.map(({ item }) => item) };
        const selected = choices.find(({ item }) => item.id === appId);
        if (!selected) return failed();
        // Discovery can be slow: don't launch after the session/path has changed.
        const currentRoot = await lookupRoot(backendUrl, target, fetcher);
        if (currentRoot !== listed || await realpath(listed) !== root || await realpath(pathApi.join(root, ...target.segments)) !== path) return notFound();
        const current = await inspect(path);
        if (info.dev !== current.dev || info.ino !== current.ino || !trusted()) return failed();
        if (await system.open(path, selected.nativeId, target.kind) === false) return failed();
        return { ok: true };
      }
      if (target.kind === "file") shell.showItemInFolder(path);
      else if (await shell.openPath(path) !== "") return failed();
      return { ok: true };
    } catch (error) {
      return error?.code === "ENOENT" || error?.code === "ENOTDIR" ? notFound() : failed();
    }
  };
  ipcMain.handle("file-manager:show", handle("show"));
  ipcMain.handle("file-manager:list-apps", handle("list"));
  ipcMain.handle("file-manager:open-with", handle("open"));
}
