import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs";
import { lstat } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { promisify } from "node:util";

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

async function isMacFolder(path) {
  // Electron openPath can launch packages (such as .app) even though they are
  // directories on disk. Ask Launch Services before handing a path to openPath.
  // The path is a positional argument, never interpolated into script or shell syntax.
  const { stdout } = await exec("/usr/bin/osascript", ["-l", "JavaScript", "-e",
    'ObjC.import("AppKit"); function run(argv) { return $.NSWorkspace.sharedWorkspace.isFilePackageAtPath(argv[0]) ? "package" : "folder"; }',
    "--", path], { timeout: 3000 });
  return stdout.trim() === "folder";
}

function createSystemShell(platform, systemRoot, runFile, spawnProcess) {
  const macShow = (args, path) => runFile("/usr/bin/open", [...args, "--", path], { shell: false, timeout: 3000 });
  if (platform === "darwin") return {
    showItemInFolder: path => macShow(["-R"], path),
    openPath: async path => { await macShow(["-a", "Finder"], path); return ""; },
  };

  // The existing Windows helper only discovers and launches known handlers.
  // Explorer's command line is a separate grammar, not ordinary argv quoting.
  // Refuse ambiguous inputs rather than letting Explorer select a different item.
  const explorerPath = path => localAbsolute(path, "win32") && path.length <= 4096 && !/[,=%]/.test(path)
    && path.slice(3).split(/[\\/]/).every(part => !/^CON(?:IN|OUT)\$ *(?:\.|$)/i.test(part))
    && win32.normalize(path) === path;
  let root = typeof systemRoot === "string" ? systemRoot.replaceAll("/", "\\") : undefined;
  if (root?.length > 3 && root.endsWith("\\")) root = root.slice(0, -1);
  const explorer = explorerPath(root) && win32.join(root, "explorer.exe");
  const show = (path, select) => {
    if (!explorer || !explorerPath(path) || (path.length > 3 && path.endsWith("\\"))) return false;
    // No parent-folder fallback: /select targets exactly this absolute file.
    // Only drive roots can end in backslash; leave those unquoted.
    const argument = `${select ? "/select," : "/e,"}${path.length === 3 ? path : `"${path}"`}`;
    return new Promise(resolve => {
      const child = spawnProcess(explorer, [argument], {
        argv0: `"${explorer}"`, cwd: root, shell: false, windowsVerbatimArguments: true, stdio: "ignore",
      });
      child.once("error", () => resolve(false));
      // Explorer's exit status does not report whether its handoff succeeded.
      child.once("spawn", () => { child.unref(); resolve(true); });
    });
  };
  return {
    showItemInFolder: path => show(path, true),
    openPath: async path => await show(path, false) ? "" : "failed",
  };
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

export function createNativeFileActions({ platform = process.platform, realpath = canonicalPath, inspect = lstat,
  macFolder = isMacFolder, getApps = systemApps, systemRoot = process.env.SystemRoot, runFile = exec, spawnProcess = spawn,
  shell = createSystemShell(platform, systemRoot, runFile, spawnProcess) } = {}) {
  const pathApi = platform === "win32" ? win32 : posix;
  return async (operation, input, appId, { lookupRoot, trusted }) => {
    try {
      if (platform !== "darwin" && platform !== "win32") return failed();
      if (operation !== "show" && operation !== "list" && operation !== "open") return failed();
      if (!trusted()) return failed();
      const target = parseTarget(input, platform);
      if (!target || (operation !== "show" && !target.sessionId)) return failed();
      if (operation === "open" && (typeof appId !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(appId))) return failed();
      const listed = await lookupRoot(target);
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
        const currentRoot = await lookupRoot(target);
        if (currentRoot !== listed || await realpath(listed) !== root || await realpath(pathApi.join(root, ...target.segments)) !== path) return notFound();
        const current = await inspect(path);
        if (info.dev !== current.dev || info.ino !== current.ino || !trusted()) return failed();
        if (await system.open(path, selected.nativeId, target.kind) === false) return failed();
        return { ok: true };
      }
      if (target.kind === "file") {
        if (await shell.showItemInFolder(path) === false) return failed();
      } else if (await shell.openPath(path) !== "") return failed();
      return { ok: true };
    } catch (error) {
      return error?.code === "ENOENT" || error?.code === "ENOTDIR" ? notFound() : failed();
    }
  };
}
