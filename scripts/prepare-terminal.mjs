import { chmod, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// node-pty 1.1.0 publishes its macOS spawn-helper without an executable bit.
// Keep clean installs usable without altering the user's global environment.
if (process.platform === "darwin") {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve("node-pty/package.json"));
  const helper = join(root, "prebuilds", `darwin-${process.arch}`, "spawn-helper");
  try { const info = await stat(helper); await chmod(helper, info.mode | 0o100); }
  catch (error) { if (error.code !== "ENOENT") throw error; } // Source builds provide their own executable.
}
