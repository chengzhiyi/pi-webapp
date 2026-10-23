import { access, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve, sep } from "node:path";
import { createRequire } from "node:module";

// Version of the shell/launcher contract, independent of the npm package version.
export const desktopProtocolVersion = 1;
export const desktopUpdatePath = agentDir => join(agentDir, "pi-web", "desktop-update.json");

function compare(a, b) {
  const parts = value => /^\d+\.\d+\.\d+$/.test(value ?? "") ? value.split(".").map(Number) : null;
  const left = parts(a); const right = parts(b);
  if (!left || !right) throw new Error("无效的桌面业务包版本");
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
}

// Resolve metadata without executing dependencies or relying on package.json exports.
export async function dependencyRoot(packageRoot, name) {
  const require = createRequire(join(packageRoot, "package.json"));
  for (const directory of require.resolve.paths(name) ?? []) {
    const candidate = join(directory, name);
    try {
      if (JSON.parse(await readFile(join(candidate, "package.json"), "utf8")).name === name) return await realpath(candidate);
    } catch { /* Try the next Node resolution directory. */ }
  }
  throw new Error(`缺少运行依赖：${name}`);
}

export async function validateDesktopRelease(agentDir, release) {
  compare(release?.version, release?.version);
  if (release.desktopProtocolVersion !== desktopProtocolVersion || typeof release.launcher !== "string") throw new Error("桌面业务包协议不兼容");
  const root = await realpath(resolve(dirname(release.launcher), ".."));
  const releases = await realpath(join(agentDir, "pi-web", "releases"));
  const directory = dirname(dirname(root));
  if (await realpath(release.launcher) !== join(root, "bin", "pi-webapp.mjs")
      || dirname(directory) !== releases || !directory.startsWith(releases + sep)
      || !/^\d+\.\d+\.\d+-[\w-]+$/.test(directory.slice(releases.length + 1))) throw new Error("拒绝用户更新目录之外的桌面业务包");
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (pkg.name !== "pi-webapp" || pkg.version !== release.version) throw new Error("桌面业务包版本与记录不一致");
  if (pkg.piWebappDesktopProtocol !== desktopProtocolVersion) throw new Error("新版业务包需要更新桌面外壳，尚未切换运行版本");
  const piRoot = await dependencyRoot(root, "@earendil-works/pi-coding-agent");
  if (!piRoot.startsWith(directory + sep)) throw new Error("桌面业务包缺少独立的 Pi 运行依赖");
  const piCli = join(piRoot, "dist", "bundle", "cli.js");
  await Promise.all([release.launcher, piCli, join(root, "dist", "extension.js"), join(root, "web", "dist", "index.html")].map(path => access(path)));
  return { version: release.version, launcher: release.launcher, piCli, desktopProtocolVersion };
}

/** Invalid, older or incomplete selections never replace the bundled fallback. */
export async function readDesktopRelease(agentDir, minimumVersion) {
  try {
    const release = JSON.parse(await readFile(desktopUpdatePath(agentDir), "utf8"));
    if (compare(release.version, minimumVersion) < 0) return null;
    return await validateDesktopRelease(agentDir, release);
  } catch { return null; }
}

export async function writeDesktopRelease(agentDir, release) {
  const path = desktopUpdatePath(agentDir);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(release), { mode: 0o600 });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

/** Only roll back our own failed selection, never a replacement from another client. */
export async function rollbackDesktopRelease(agentDir, failedLauncher) {
  try {
    const path = desktopUpdatePath(agentDir);
    const release = JSON.parse(await readFile(path, "utf8"));
    if (release.launcher !== failedLauncher) return;
    if (release.previous) {
      try {
        const previous = await validateDesktopRelease(agentDir, release.previous);
        await writeDesktopRelease(agentDir, previous);
        return;
      } catch { /* Fall back to the application's bundled package. */ }
    }
    await rm(path, { force: true });
  } catch (error) { if (error.code !== "ENOENT") throw error; }
}
