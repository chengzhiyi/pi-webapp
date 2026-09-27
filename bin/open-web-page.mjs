import { execFile } from "node:child_process";

const runOpenCommand = (command, args) => new Promise((resolve, reject) => {
  execFile(command, [...args], { windowsHide: true }, (error) => {
    if (error) reject(error);
    else resolve();
  });
});

/** Open on the host desktop only when this process has a local graphical session. */
export async function openWebPage(url, platform = process.platform, env = process.env, run = runOpenCommand) {
  if (env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT) return false;
  if (platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) return false;
  const command = platform === "darwin" ? "open" : platform === "linux" ? "xdg-open" : platform === "win32" ? "explorer.exe" : null;
  if (command === null) return false;
  await run(command, [url]);
  return true;
}
