import { chmod } from "node:fs/promises";
import { join } from "node:path";

export function nativeBuildEnvironment(base, nodeVersion, nodeRoot) {
  const overrides = new Set(["npm_config_runtime", "npm_config_target", "npm_config_disturl", "npm_config_nodedir", "npm_config_build_from_source", "electron_run_as_node", "node_options"]);
  const env = Object.fromEntries(Object.entries(base).filter(([key]) => !overrides.has(key.toLowerCase())));
  return { ...env, npm_config_runtime: "node", npm_config_target: nodeVersion,
    npm_config_nodedir: nodeRoot, npm_config_build_from_source: "true" };
}

/** Only the pinned node-pty lifecycle is enabled; no Electron ABI or host addon reuse. */
export async function prepareNativePty({ platform, arch, node, nodeRoot, nodeVersion, npmCli, backend, env, run }) {
  const ptyRoot = join(backend, "node_modules/node-pty");
  if (platform === "linux") {
    // node-pty 1.1.0 does not ship Linux prebuilds. Unix Node archives include
    // headers, so compile with the bundled Node and its exact headers offline.
    await run(node, [npmCli, "rebuild", "node-pty", "--no-audit", "--no-fund"], {
      cwd: backend, env: nativeBuildEnvironment(env, nodeVersion, nodeRoot), timeout: 240000, maxBuffer: 8 * 1024 * 1024,
    });
    return "bundled-node-source-build";
  }
  if (platform === "win32") {
    // ci --ignore-scripts also skips copying ConPTY's DLL/helper payload.
    await run(node, [join(ptyRoot, "scripts/post-install.js")], { cwd: ptyRoot, env, timeout: 30000 });
    return "native-prebuild-and-conpty-payload";
  }
  await chmod(join(ptyRoot, "prebuilds", `darwin-${arch}`, "spawn-helper"), 0o755);
  return "native-prebuild";
}
