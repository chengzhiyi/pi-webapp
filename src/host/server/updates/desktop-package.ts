import { execFile } from "node:child_process";
import { cp, readFile, realpath, rm } from "node:fs/promises";
import { join, sep } from "node:path";
import { promisify } from "node:util";
import { dependencyRoot } from "../../../../desktop/managed-release.mjs";

const exec = promisify(execFile);
const peers = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai"];

/** Release metadata is a pinned dependency contract, not an instruction to
 * follow npm latest or preserve a different host's historical SDK pair. */
export function exactSdkPeerSpecs(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("新版 Pi SDK 必须声明经过验证的精确版本");
  const declared = value as Record<string, unknown>;
  return peers.map(name => {
    const version = declared[name];
    if (typeof version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error("新版 Pi SDK 必须声明经过验证的精确版本");
    return `${name}@${version}`;
  });
}

/** Read the SDK pair installed with this package, never global PATH's Pi. */
export async function desktopPeerSpecs(packageRoot: string): Promise<string[]> {
  return Promise.all(peers.map(async name => {
    const root = await dependencyRoot(packageRoot, name);
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error("随包 Pi 版本无效，请更新桌面外壳");
    return `${name}@${pkg.version}`;
  }));
}

/** Reuse only the exact native dependency already tested with this standalone Node.
 * No arbitrary npm lifecycle scripts or compiler installation runs during updates.
 */
export async function verifyDesktopPackage(packageRoot: string, installed: string): Promise<void> {
  const candidate = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
  if (candidate.name !== "pi-webapp") throw new Error("新版业务包元数据无效");
  // Old releases without a dependency contract retain their historical SDK pair.
  // Explicitly pinned newer releases verify against their own tested contract.
  const expectedPeers = candidate.peerDependencies === undefined ? await desktopPeerSpecs(packageRoot) : exactSdkPeerSpecs(candidate.peerDependencies);
  if (JSON.stringify(await desktopPeerSpecs(installed)) !== JSON.stringify(expectedPeers)) throw new Error("新版 Pi SDK 安装版本与业务包声明不符，当前应用未修改");
  const source = await dependencyRoot(packageRoot, "node-pty");
  const destination = await dependencyRoot(installed, "node-pty");
  const prefix = await realpath(join(installed, "../.."));
  if (source === destination || !destination.startsWith(prefix + sep)) throw new Error("新版终端依赖不在独立更新目录内");
  const version = async (root: string) => JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
  if (await version(source) !== await version(destination)) throw new Error("新版终端原生依赖需要更新桌面外壳；当前应用未修改");
  await rm(destination, { recursive: true, force: true });
  await cp(source, destination, { recursive: true });
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  delete env.ELECTRON_RUN_AS_NODE;
  await exec(process.execPath, [join(installed, "desktop", "check-pty.cjs")], {
    cwd: installed, env, timeout: 20000, maxBuffer: 1024 * 1024, windowsHide: true,
  });
  const pi = await dependencyRoot(installed, peers[0]!);
  const { stdout } = await exec(process.execPath, [join(pi, "dist", "bundle", "cli.js"), "--version"], {
    cwd: installed, env, timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true,
  });
  if (stdout.trim() !== expectedPeers[0]!.split("@").at(-1)) throw new Error("新版 Pi CLI 版本校验失败，当前运行版本未修改");
}
