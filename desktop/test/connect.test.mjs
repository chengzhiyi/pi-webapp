import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { DesktopConnectionError } from "../backend.mjs";
import { connectBackend } from "../connect.mjs";
import { setDesktopLocale } from "../locale.mjs";

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

test("recovery can check desktop updates without stopping/replacing the incompatible backend", async () => {
  let checks = 0; let attempts = 0;
  const state = { pid: 42 };
  const result = await connectBackend({ connect: async () => { if (++attempts === 1) throw incompatible(); return state; }, stop: noStop }, {
    showMessageBox: async options => {
      assert.deepEqual(options.buttons, ["重新检查", "在浏览器继续使用", "检查桌面更新", "退出"]);
      assert.ok(!JSON.stringify(options).includes(address));
      return { response: 2 };
    }, openExternal: noStop, checkDesktopUpdates: async () => checks++,
  });
  assert.equal(checks, 1); assert.equal(attempts, 2); assert.equal(result, state);
});

test("startup update install does not retry the backend or force app.exit before native relaunch", async () => {
  let installing = false; let attempts = 0;
  const result = await connectBackend({ connect: async () => { attempts++; throw incompatible(); }, stop: noStop }, {
    showMessageBox: async options => ({ response: options.buttons.indexOf("检查桌面更新") }), openExternal: noStop,
    checkDesktopUpdates: async () => { installing = true; }, isInstalling: () => installing,
  });
  assert.equal(result, null); assert.equal(attempts, 1);
});

test("unexpected startup failures are not silently treated as compatible or retried", async () => {
  const error = new Error("unexpected startup failure");
  await assert.rejects(connectBackend({ connect: async () => { throw error; }, stop: noStop }, { showMessageBox: noStop, openExternal: noStop }), value => value === error);
});

const identity = { version: "0.1.52", runtimeKind: "npm", pid: 4242, cwd: "/Users/me/pi-webapp-spike-pencil", stoppable: true };
const command = "'/App/node' '/App/pi-webapp.mjs' stop";
function hung(locale = "zh") {
  const error = new DesktopConnectionError("health-failed", locale === "zh" ? "已有本地服务在 5 秒内没有响应健康检查" : "did not answer within 5 seconds", undefined, "timeout");
  error.backend = identity;
  return error;
}

for (const [locale, labels] of [["zh", { recheck: "重新检查", copy: "复制停止命令", quit: "退出", backend: "后台：版本 0.1.52 · npm · PID 4242", cwd: "工作目录：/Users/me/pi-webapp-spike-pencil", force: "--force", lost: "未保存的插件编辑可能丢失", copied: "停止命令已复制到剪贴板" }],
  ["en", { recheck: "Check Again", copy: "Copy Stop Command", quit: "Quit", backend: "Backend: version 0.1.52 · npm · PID 4242", cwd: "Working directory: /Users/me/pi-webapp-spike-pencil", force: "--force", lost: "unsaved plugin edits may be lost", copied: "copied to the clipboard" }]]) {
  test(`${locale}: a hung backend names itself and offers its stop command only as copyable text`, async () => {
    setDesktopLocale(locale);
    try {
      let attempts = 0; const copied = []; const dialogs = [];
      const backend = { connect: async () => { attempts++; throw hung(locale); }, stop: noStop, stopCommand: ({ force } = {}) => { assert.equal(force, undefined); return command; } };
      const result = await connectBackend(backend, { showMessageBox: async options => {
        dialogs.push(options);
        assert.deepEqual(options.buttons, [labels.recheck, labels.copy, labels.quit]);
        assert.ok(!JSON.stringify(options).includes(address));
        return { response: dialogs.length === 1 ? 1 : options.cancelId };
      }, openExternal: noStop, copyText: text => copied.push(text) });
      assert.equal(result, null);
      assert.deepEqual(copied, [command]);
      assert.equal(attempts, 1, "copying must not re-probe the backend");
      const [first, second] = dialogs;
      for (const text of [labels.backend, labels.cwd, command, labels.force, labels.lost]) assert.ok(first.detail.includes(text), text);
      assert.ok(!first.detail.includes(labels.copied));
      assert.ok(second.detail.includes(labels.copied));
    } finally { setDesktopLocale("zh"); }
  });
}

test("check again stays non-destructive for a hung backend and the copy button needs a stoppable identity and clipboard", async () => {
  let attempts = 0; const state = { pid: 42 };
  const backend = { connect: async () => { if (++attempts === 1) throw hung(); return state; }, stop: noStop, stopCommand: () => command };
  assert.equal(await connectBackend(backend, { showMessageBox: async options => {
    assert.deepEqual(options.buttons, ["重新检查", "复制停止命令", "退出"]);
    return { response: 0 };
  }, openExternal: noStop, copyText: noStop }), state);
  assert.equal(attempts, 2);
  const cases = [[{ ...identity, stoppable: false }, text => text], [identity, undefined]];
  for (const [value, copyText] of cases) {
    const error = hung(); error.backend = value;
    await connectBackend({ connect: async () => { throw error; }, stop: noStop, stopCommand: () => command }, { showMessageBox: async options => {
      assert.deepEqual(options.buttons, ["重新检查", "退出"]);
      assert.ok(options.detail.includes("PID 4242"));
      assert.ok(!options.detail.includes(command));
      return { response: options.cancelId };
    }, openExternal: noStop, copyText });
  }
});
