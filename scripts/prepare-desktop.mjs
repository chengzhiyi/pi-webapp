import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const work = join(root, ".desktop");
const runtime = join(work, "runtime");
const nodeVersion = "22.23.3";
const platform = process.platform;
const arch = process.arch;
if (!["darwin", "linux", "win32"].includes(platform) || !["arm64", "x64"].includes(arch)) throw new Error("Unsupported desktop platform");
// Host-only preparation: never silently package host binaries as another architecture.
if (process.argv.slice(2).length) throw new Error("Run desktop preparation and packaging on the target OS/architecture; no cross-build flags are supported.");
const nodePlatform = platform === "win32" ? "win" : platform;
const archiveName = `node-v${nodeVersion}-${nodePlatform}-${arch}.${platform === "win32" ? "zip" : "tar.gz"}`;
const distribution = `https://nodejs.org/dist/v${nodeVersion}/`;
await mkdir(work, { recursive: true });

async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120000), redirect: "error" });
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

console.log(`Preparing standalone Node ${nodeVersion} for ${platform}-${arch}…`);
const checksums = (await download(`${distribution}SHASUMS256.txt`)).toString("utf8");
const expected = checksums.split("\n").map(line => line.trim().split(/\s+/)).find(parts => parts[1] === archiveName)?.[0];
if (!/^[a-f0-9]{64}$/.test(expected ?? "")) throw new Error("Official Node checksum not found");
const archive = join(work, archiveName);
let bytes;
try { bytes = await readFile(archive); } catch { /* First build. */ }
if (!bytes || createHash("sha256").update(bytes).digest("hex") !== expected) {
  bytes = await download(`${distribution}${archiveName}`);
  if (createHash("sha256").update(bytes).digest("hex") !== expected) throw new Error("Node archive checksum mismatch");
  await writeFile(archive, bytes);
}
const extracted = join(work, `node-v${nodeVersion}-${nodePlatform}-${arch}`);
await rm(extracted, { recursive: true, force: true });
// Modern Windows includes bsdtar, which also extracts zip. No shell interpolation.
await exec("tar", ["-xf", archive, "-C", work], { timeout: 120000 });
await rm(runtime, { recursive: true, force: true });
await mkdir(runtime, { recursive: true });
await rename(extracted, join(runtime, "node"));
const nodeRoot = join(runtime, "node");
const node = platform === "win32" ? join(nodeRoot, "node.exe") : join(nodeRoot, "bin", "node");
const npmCli = join(nodeRoot, platform === "win32" ? "node_modules" : "lib/node_modules", "npm", "bin", "npm-cli.js");
const version = (await exec(node, ["--version"])).stdout.trim();
if (version !== `v${nodeVersion}`) throw new Error("Bundled Node version mismatch");

const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const manifestRoot = join(root, "desktop", "runtime-manifest");
const expectedDependencies = { ...pkg.dependencies,
  "@earendil-works/pi-ai": pkg.devDependencies["@earendil-works/pi-ai"],
  "@earendil-works/pi-coding-agent": pkg.devDependencies["@earendil-works/pi-coding-agent"] };
const manifest = JSON.parse(await readFile(join(manifestRoot, "package.json"), "utf8"));
if (JSON.stringify(Object.entries(manifest.dependencies).sort()) !== JSON.stringify(Object.entries(expectedDependencies).sort())) {
  throw new Error("Desktop runtime dependencies are out of sync. See docs/desktop.md to refresh the runtime lockfile.");
}
const backend = join(runtime, "backend");
await mkdir(backend);
await cp(join(manifestRoot, "package.json"), join(backend, "package.json"));
await cp(join(manifestRoot, "package-lock.json"), join(backend, "package-lock.json"));
const env = { ...process.env, npm_execpath: npmCli };
const pathKey = Object.keys(env).find(key => key.toLowerCase() === "path") ?? "PATH";
env[pathKey] = `${dirname(node)}${delimiter}${env[pathKey] ?? ""}`;
delete env.NODE_OPTIONS;
delete env.ELECTRON_RUN_AS_NODE;
// Fixed lockfile; prebuilt N-API modules are verified below, not rebuilt against Electron.
await exec(node, [npmCli, "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
  cwd: backend, env, timeout: 240000, maxBuffer: 8 * 1024 * 1024,
});
for (const name of ["bin", "dist", "web/dist", "LICENSE", "README.md", "README.zh-CN.md"]) {
  await cp(join(root, name), join(backend, name), { recursive: true });
}
// Preserve the real package name/version used by SelfUpdater and the launcher.
manifest.name = pkg.name;
manifest.version = pkg.version;
manifest.type = "module";
await writeFile(join(backend, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
if (platform === "darwin") {
  await chmod(join(backend, "node_modules", "node-pty", "prebuilds", `darwin-${arch}`, "spawn-helper"), 0o755);
}
// Fail the build, not the user's first launch, on a missing/broken native PTY.
const ptyCheck = `const pty = require('node-pty'); const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
const args = process.platform === 'win32' ? ['/c', 'echo PI_DESKTOP_PTY_OK'] : ['-c', 'printf PI_DESKTOP_PTY_OK'];
const terminal = pty.spawn(shell, args, { cols: 80, rows: 24 }); let text = '';
terminal.onData(data => text += data); terminal.onExit(() => { if (!text.includes('PI_DESKTOP_PTY_OK')) process.exitCode = 1; });`;
await exec(node, ["-e", ptyCheck], { cwd: backend, env, timeout: 15000 });
const piCli = join(backend, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
const piVersion = (await exec(node, [piCli, "--version"], { cwd: backend, env, timeout: 30000 })).stdout.trim();
if (piVersion !== pkg.devDependencies["@earendil-works/pi-coding-agent"]) throw new Error("Bundled Pi version mismatch");
await writeFile(join(runtime, "build-info.json"), JSON.stringify({ version: pkg.version, nodeVersion, piVersion, platform, arch,
  nodeArchiveSha256: expected }, null, 2) + "\n");
console.log(`Desktop runtime ready: ${runtime}`);
