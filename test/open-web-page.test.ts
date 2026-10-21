import assert from "node:assert/strict";
import test from "node:test";
import { openWebPage } from "../src/host/server/updates/open-web-page.ts";

const url = "http://127.0.0.1:1234/#secret-token";

test("opens the local page with the host's default browser", async () => {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const run = async (command: string, args: readonly string[]) => { calls.push({ command, args }); };
  assert.equal(await openWebPage(url, "darwin", {}, run), true);
  assert.equal(await openWebPage(url, "linux", { DISPLAY: ":0" }, run), true);
  assert.equal(await openWebPage(url, "win32", {}, run), true);
  assert.deepEqual(calls, [
    { command: "open", args: [url] },
    { command: "xdg-open", args: [url] },
    { command: "explorer.exe", args: [url] },
  ]);
});

test("desktop and explicit no-open never invoke a potentially blocking external browser", async () => {
  const run = async () => { throw new Error("external browser must not be launched or awaited"); };
  for (const platform of ["linux", "darwin", "win32"] as const) {
    assert.equal(await openWebPage(url, platform, { DISPLAY: ":99", PI_WEBAPP_AUTO_OPEN: "0" }, run), false);
    assert.equal(await openWebPage(url, platform, { DISPLAY: ":99", PI_WEBAPP_AUTO_OPEN: "1", PI_WEBAPP_RUNTIME: "desktop" }, run), false);
  }
});

test("leaves remote and headless sessions to use the displayed URL", async () => {
  const run = async () => { throw new Error("browser command should not run"); };
  assert.equal(await openWebPage(url, "darwin", { SSH_CONNECTION: "remote" }, run), false);
  assert.equal(await openWebPage(url, "linux", {}, run), false);
  assert.equal(await openWebPage(url, "freebsd", {}, run), false);
});
