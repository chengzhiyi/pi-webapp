import assert from "node:assert/strict";
import test from "node:test";
import { openWebPage } from "../extension/open-web-page.ts";

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

test("leaves remote and headless sessions to use the displayed URL", async () => {
  const run = async () => { throw new Error("browser command should not run"); };
  assert.equal(await openWebPage(url, "darwin", { SSH_CONNECTION: "remote" }, run), false);
  assert.equal(await openWebPage(url, "linux", {}, run), false);
  assert.equal(await openWebPage(url, "freebsd", {}, run), false);
});
