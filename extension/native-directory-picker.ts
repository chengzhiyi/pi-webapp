/** Native directory picker with a no-shell command runner. */
import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

export type PickerKind = "native" | "browse";
export type PickerRunner = (command: string, args: readonly string[], signal: AbortSignal) => Promise<{ stdout: string; stderr: string }>;

export const runNativeCommand: PickerRunner = (command, args, signal) => new Promise((resolve, reject) => {
  execFile(command, [...args], { encoding: "utf8", signal, windowsHide: true }, (error, stdout, stderr) => {
    if (error) reject(Object.assign(new Error(error.message, { cause: error }), { code: error.code, stdout, stderr }));
    else resolve({ stdout, stderr });
  });
});

function hasLinuxChooser(pathValue: string | undefined): boolean {
  for (const directory of (pathValue ?? "").split(delimiter)) {
    if (!directory) continue;
    for (const name of ["zenity", "kdialog"]) {
      try { accessSync(join(directory, name), constants.X_OK); return true; }
      catch { /* Try the next executable. */ }
    }
  }
  return false;
}

/** Use the host display only for an attended local launch. */
export function directoryPickerKind(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): PickerKind {
  if (env.SSH_CONNECTION || env.SSH_TTY) return "browse";
  if (platform === "darwin") return "native";
  if (platform === "linux" && (env.DISPLAY || env.WAYLAND_DISPLAY) && hasLinuxChooser(env.PATH)) return "native";
  return "browse";
}

function codeOf(error: unknown): string | number | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" || typeof error.code === "number" ? error.code : undefined;
}

function stderrOf(error: unknown): string {
  return typeof error === "object" && error !== null && "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
}

function outputPath(stdout: string): string | null {
  return stdout.replace(/[\r\n]+$/, "") || null;
}

export async function pickNativeDirectory(signal: AbortSignal, platform: NodeJS.Platform = process.platform, run: PickerRunner = runNativeCommand): Promise<string | null> {
  if (platform === "darwin") {
    try {
      const result = await run("osascript", [
        "-e", 'set selectedFolder to choose folder with prompt "Select Workspace Directory"',
        "-e", "POSIX path of selectedFolder",
      ], signal);
      return outputPath(result.stdout);
    } catch (error) {
      if (!signal.aborted && codeOf(error) === 1 && /(?:User canceled|-128)/i.test(stderrOf(error))) return null;
      throw error;
    }
  }
  if (platform === "linux") {
    try {
      return outputPath((await run("zenity", ["--file-selection", "--directory", "--title=Select Workspace Directory"], signal)).stdout);
    } catch (error) {
      if (signal.aborted) throw error;
      if (codeOf(error) === 1) return null;
      if (codeOf(error) !== "ENOENT") throw error;
    }
    try {
      return outputPath((await run("kdialog", ["--getexistingdirectory", ".", "--title", "Select Workspace Directory"], signal)).stdout);
    } catch (error) {
      if (signal.aborted) throw error;
      if (codeOf(error) === 1) return null;
      throw error;
    }
  }
  throw new Error(`当前系统不支持本地目录选择器：${platform}`);
}
