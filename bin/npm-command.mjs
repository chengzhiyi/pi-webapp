import { realpathSync, statSync } from "node:fs";
import { basename, delimiter, dirname, join, resolve } from "node:path";

function npmEntry(path) {
  if (!path) return null;
  try {
    const real = realpathSync(path);
    return basename(real) === "npm-cli.js" && statSync(real).isFile() ? real : null;
  } catch { return null; }
}

/** Find npm's JavaScript entry point without relying on executable shell shims. */
export function resolveNpmCli({ execPath = process.execPath, env = process.env } = {}) {
  const inherited = npmEntry(env.npm_execpath);
  if (inherited) return inherited;

  const directories = new Set([dirname(execPath)]);
  try { directories.add(dirname(realpathSync(execPath))); } catch { /* Try the original path. */ }
  const searchPath = Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1] ?? "";
  for (const directory of searchPath.split(delimiter).filter(Boolean)) directories.add(resolve(directory));
  for (const directory of directories) {
    for (const candidate of [
      join(directory, "node_modules", "npm", "bin", "npm-cli.js"),
      join(directory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
      join(directory, "npm"),
    ]) {
      const cli = npmEntry(candidate);
      if (cli) return cli;
    }
  }
  throw new Error("找不到 npm 入口 npm-cli.js；请安装包含 npm 的 Node.js，或将 npm 所在目录加入 PATH 后重启服务。");
}

export function npmCommand(args) {
  return { file: process.execPath, args: [resolveNpmCli(), ...args] };
}
