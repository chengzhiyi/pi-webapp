import { execFile } from "node:child_process";

type OpenPageRunner = (command: string, args: readonly string[]) => Promise<void>;

const runOpenCommand: OpenPageRunner = (command, args) => new Promise((resolve, reject) => {
  execFile(command, [...args], { windowsHide: true }, (error) => {
    if (error) reject(error);
    else resolve();
  });
});

/** Open on the host desktop only when the Pi process has a local graphical session. */
export async function openWebPage(
  url: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  run: OpenPageRunner = runOpenCommand,
): Promise<boolean> {
  if (env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT) return false;
  if (platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) return false;
  const command = platform === "darwin" ? "open" : platform === "linux" ? "xdg-open" : platform === "win32" ? "explorer.exe" : null;
  if (command === null) return false;
  await run(command, [url]);
  return true;
}
