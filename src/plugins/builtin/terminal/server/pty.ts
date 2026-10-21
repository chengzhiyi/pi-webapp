import { accessSync, chmodSync, constants, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

/** node-pty 1.1.0 ships macOS helpers as 0644. Installs may skip postinstall. */
export function prepareTerminalHelper(root: string) {
  if (process.platform !== "darwin") return;
  // Match node-pty's native build locations, including source builds.
  for (const directory of ["build/Release", "build/Debug", `prebuilds/darwin-${process.arch}`]) {
    const helper = join(root, directory, "spawn-helper");
    let mode: number;
    try { mode = statSync(helper).mode; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    // Do not change already executable helpers in read-only/signed app bundles.
    try { accessSync(helper, constants.X_OK); }
    catch { chmodSync(helper, mode | 0o111); }
  }
}

export function spawnTerminal(...args: Parameters<typeof import("node-pty").spawn>) {
  prepareTerminalHelper(dirname(require.resolve("node-pty/package.json")));
  return (require("node-pty") as typeof import("node-pty")).spawn(...args);
}
