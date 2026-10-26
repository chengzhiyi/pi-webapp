import { access, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { dependencyRoot } from "../desktop/managed-release.mjs";

/** Published launchers must use the same SDK pair as their extension, not PATH's
 * possibly newer Pi. Source checkouts retain the developer's CLI workflow.
 * Legacy packages without exact peer contracts retain their old launch path.
 */
export async function packagePiCli(packageRoot) {
  if (existsSync(join(packageRoot, ".git"))) return null;
  const pkg = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  const peers = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai"];
  if (!peers.every(name => /^\d+\.\d+\.\d+$/.test(pkg.peerDependencies?.[name] ?? ""))) return null;
  let cli;
  for (const name of peers) {
    const root = await dependencyRoot(packageRoot, name);
    const installed = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    if (installed.version !== pkg.peerDependencies[name]) {
      throw new Error(`Pi SDK 版本不匹配：${name} 需要 ${pkg.peerDependencies[name]}，实际为 ${installed.version}。请重新安装 pi-webapp；全局 Pi 未修改。`);
    }
    if (name === peers[0]) cli = join(root, "dist", "bundle", "cli.js");
  }
  await access(cli);
  return cli;
}
