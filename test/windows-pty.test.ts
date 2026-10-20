import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("native Windows PTY supports interactive cmd, cursor-query responses and clean command exit", { skip: process.platform !== "win32" }, async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const script = fileURLToPath(new URL("../desktop/check-pty.cjs", import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [script], { cwd: root, timeout: 20000 });
  assert.match(stdout, /PI_DESKTOP_PTY_OK \(interactive terminal and exit verified\)/);
});
