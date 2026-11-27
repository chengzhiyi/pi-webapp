import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { isAbsolute } from "node:path/posix";
import { promisify } from "node:util";

const exec = promisify(execFile);
const LIMIT = 16;
const ICON_BYTES = 16 * 1024;
const isLocalPath = path => typeof path === "string" && isAbsolute(path) && !path.includes("\0");

// NSWorkspace uses the actual item's Launch Services associations, including
// folder handlers. The script is fixed; paths only enter through run(argv).
const QUERY = `
ObjC.import("AppKit");

function localPath(url) {
  if (!url.isFileURL) return;
  return ObjC.unwrap(url.URLByResolvingSymlinksInPath.path);
}

function pngIcon(workspace, path) {
  const source = workspace.iconForFile(path);
  const canvas = $.NSImage.alloc.initWithSize($.NSMakeSize(32, 32));
  const rect = $.NSMakeRect(0, 0, 32, 32);
  let bitmap;
  canvas.lockFocus;
  try {
    source.drawInRectFromRectOperationFraction(rect, $.NSZeroRect, $.NSCompositingOperationSourceOver, 1);
    bitmap = $.NSBitmapImageRep.alloc.initWithFocusedViewRect(rect);
  } finally {
    canvas.unlockFocus;
  }
  if (!(bitmap.pixelsWide <= 64 && bitmap.pixelsHigh <= 64)) return;
  const png = bitmap.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $.NSDictionary.dictionary);
  if (png.length > 0 && png.length <= ${ICON_BYTES}) {
    return "data:image/png;base64," + ObjC.unwrap(png.base64EncodedStringWithOptions(0));
  }
}

function run(argv) {
  const [path, kind, selected] = argv;
  const directory = kind === "directory";
  const workspace = $.NSWorkspace.sharedWorkspace;
  const files = $.NSFileManager.defaultManager;
  const userApps = localPath($.NSURL.fileURLWithPathIsDirectory(ObjC.unwrap($.NSHomeDirectory()) + "/Applications", true));
  const installedRoots = ["/Applications/", "/System/Applications/", "/System/Library/CoreServices/", userApps + "/"];
  // A package is not a normal directory target (e.g. a workspace-local .app).
  if (directory && workspace.isFilePackageAtPath(path)) return selected ? "false" : "[]";
  const target = $.NSURL.fileURLWithPathIsDirectory(path, directory);
  const primary = workspace.URLForApplicationToOpenURL(target);
  const defaultPath = localPath(primary);
  const handlers = workspace.URLsForApplicationsToOpenURL(target);
  const seen = new Set();
  // Updaters and test installs can register extra copies of the same app.
  const bundleIds = new Set();
  const entries = [];
  // Visit the default first even when Launch Services orders the array differently.
  for (let i = -1; i < handlers.count && entries.length < ${LIMIT}; i++) {
    const url = i === -1 ? primary : handlers.objectAtIndex(i);
    const id = localPath(url);
    if (!id || !/^\\/.*\\.app$/is.test(id) || seen.has(id) || !installedRoots.some(root => id.startsWith(root))) continue;
    seen.add(id);
    const bundle = $.NSBundle.bundleWithPath(id);
    const bundleId = ObjC.unwrap(bundle.bundleIdentifier)?.toLowerCase();
    if (!bundleId || /^(?:com[.]apple[.](?:finder|terminal|scripteditor2|automator|shortcuts)|com[.]googlecode[.]iterm2|dev[.]warp[.]warp-stable)$/i.test(bundleId) || bundleIds.has(bundleId)) continue;
    if (ObjC.unwrap(bundle.objectForInfoDictionaryKey("CFBundlePackageType")) !== "APPL") continue;
    const executable = localPath(bundle.executableURL);
    if (!executable || !executable.startsWith(id + "/") || !files.isExecutableFileAtPath(executable)) continue;
    const attrs = files.attributesOfItemAtPathError(executable, null);
    if (ObjC.unwrap(attrs.objectForKey($.NSFileType)) !== ObjC.unwrap($.NSFileTypeRegular)) continue;
    bundleIds.add(bundleId);
    if (selected) {
      if (id === selected) return "true";
      if (bundleIds.size === ${LIMIT}) return "false";
      continue;
    }
    const displayName = ObjC.unwrap(files.displayNameAtPath(id));
    const name = displayName.replace(/\\.app$/i, "").trim().slice(0, 160) || displayName;
    const entry = { id, name };
    if (id === defaultPath) entry.isDefault = true;
    try {
      const icon = pngIcon(workspace, id);
      if (icon) entry.icon = icon;
    } catch (_) { /* Icons are optional, especially in non-GUI sessions. */ }
    entries.push(entry);
  }
  return selected ? "false" : JSON.stringify(entries);
}
`;

async function query(path, kind, appId) {
  const args = ["-l", "JavaScript", "-e", QUERY, "--", path, kind];
  if (appId !== undefined) args.push(appId);
  const { stdout } = await exec("/usr/bin/osascript", args, { timeout: 5000, maxBuffer: 640 * 1024 });
  return JSON.parse(stdout);
}

async function inspect(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
  }
}

function sameItem(before, after) {
  return after && before.dev === after.dev && before.ino === after.ino && before.mode === after.mode;
}

/** Discover installed handlers for a caller-validated absolute file or directory path. */
export async function listMacApps(path, kind) {
  if (process.platform !== "darwin" || !isLocalPath(path) || (kind !== "file" && kind !== "directory")) return [];
  const item = await inspect(path);
  if (!(kind === "directory" ? item?.isDirectory() : item?.isFile())) return [];
  return query(path, kind);
}

/** appId must be matched exactly against a fresh list by the caller. Resolves on successful dispatch. */
export async function openMacApp(path, appId) {
  if (process.platform !== "darwin" || !isLocalPath(path) || !isLocalPath(appId) || !/\.app$/i.test(appId)) {
    throw new Error("Invalid macOS Open With request");
  }
  const [target, app] = await Promise.all([inspect(path), inspect(appId)]);
  const kind = target?.isDirectory() ? "directory" : target?.isFile() ? "file" : undefined;
  if (!kind || !app?.isDirectory() || await query(path, kind, appId) !== true) {
    throw new Error("Document or associated macOS app unavailable");
  }
  // Both are absolute paths; only the document follows `--`. No shell or app argv.
  const [currentTarget, currentApp] = await Promise.all([inspect(path), inspect(appId)]);
  if (!sameItem(target, currentTarget) || !sameItem(app, currentApp)) {
    throw new Error("Document or macOS app changed before opening");
  }
  await exec("/usr/bin/open", ["-a", appId, "--", path], { timeout: 5000 });
}
