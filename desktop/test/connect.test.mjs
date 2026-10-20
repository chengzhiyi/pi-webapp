import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { DesktopConnectionError } from "../backend.mjs";
import { connectBackend } from "../connect.mjs";

const address = `http://127.0.0.1:12345/#${"c".repeat(32)}`;
const incompatible = () => new DesktopConnectionError("version-incompatible", "已有服务版本不兼容", address);
const noStop = () => { throw new Error("recovery must never stop a service"); };

test("successful connection skips recovery and its module ships in ASAR", async () => {
  const require = createRequire(import.meta.url);
  assert.ok(require("../builder.cjs").files.includes("connect.mjs"));
  const state = { pid: 42 };
  assert.equal(await connectBackend({ connect: async () => state, stop: noStop }, { showMessageBox: noStop, openExternal: noStop }), state);
});

test("retry revalidates the existing backend without stopping it or opening a browser", async () => {
  let attempts = 0;
  const state = { pid: 42 };
  const backend = { connect: async () => { if (++attempts === 1) throw incompatible(); return state; }, stop: noStop };
  const result = await connectBackend(backend, { showMessageBox: async options => {
    assert.deepEqual(options.buttons, ["重新检查", "在浏览器继续使用", "退出"]);
    assert.equal(options.defaultId, 2);
    assert.equal(options.cancelId, 2);
    assert.ok(!JSON.stringify(options).includes(address), "dialog text must not reveal the token");
    return { response: 0 };
  }, openExternal: noStop });
  assert.equal(result, state);
  assert.equal(attempts, 2);
});

test("browser recovery opens only the authenticated existing service and does not claim ownership", async () => {
  const opened = [];
  const backend = { connect: async () => { throw incompatible(); }, stop: noStop, owned: false };
  assert.equal(await connectBackend(backend, { showMessageBox: async () => ({ response: 1 }), openExternal: async url => opened.push(url) }), null);
  assert.deepEqual(opened, [address]);
  assert.equal(backend.owned, false);
});

test("exit and authentication-failure dialogs never stop the service or open unverified URLs", async () => {
  for (const error of [incompatible(), new DesktopConnectionError("authentication-failed", "认证失败")]) {
    const backend = { connect: async () => { throw error; }, stop: noStop };
    assert.equal(await connectBackend(backend, { showMessageBox: async options => {
      if (!error.browserUrl) assert.deepEqual(options.buttons, ["重新检查", "退出"]);
      return { response: options.cancelId };
    }, openExternal: noStop }), null);
  }
  assert.throws(() => new DesktopConnectionError("unsafe", "", "https://example.com"));
});

test("unexpected startup failures are not silently treated as compatible or retried", async () => {
  const error = new Error("unexpected startup failure");
  await assert.rejects(connectBackend({ connect: async () => { throw error; }, stop: noStop }, { showMessageBox: noStop, openExternal: noStop }), value => value === error);
});
