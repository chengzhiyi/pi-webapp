import assert from "node:assert/strict";
import test from "node:test";
import { confirmDesktopQuit } from "../quit.mjs";

function fixture(responses, overrides = {}) {
  const prompts = [];
  let stops = 0;
  const backend = { owned: true, refresh: async () => { throw new Error("backend unreachable"); }, stop: async () => { stops++; } };
  return { backend, prompts, get stops() { return stops; }, options: {
    appName: "pi", backend,
    showMessageBox: async options => { prompts.push(options); return { response: responses.shift() }; },
    ...overrides,
  } };
}

test("cancel keeps the desktop and owned service running", async () => {
  const f = fixture([0]);
  assert.equal(await confirmDesktopQuit(f.options), false);
  assert.equal(f.stops, 0);
});

test("keep-background exit never waits for backend health or stops it", async () => {
  const f = fixture([1]);
  assert.equal(await confirmDesktopQuit(f.options), true);
  assert.equal(f.stops, 0);
});

test("confirmed stop waits for successful shutdown before permitting exit", async () => {
  const f = fixture([2]);
  assert.equal(await confirmDesktopQuit(f.options), true);
  assert.equal(f.stops, 1);
});

test("a refused plugin flush offers explicit desktop-only exit and preserves the service", async () => {
  const f = fixture([2, 1]);
  f.backend.stop = async () => { throw new Error("停止已取消：插件保存或释放未完成"); };
  assert.equal(await confirmDesktopQuit(f.options), true);
  assert.equal(f.backend.owned, true);
  assert.match(f.prompts[1].detail, /插件保存或释放未完成/);
  assert.equal(f.prompts[1].buttons[1], "仅退出桌面");
});

test("returning from a stop failure permits a later quit attempt", async () => {
  const f = fixture([2, 0, 1]);
  f.backend.stop = async () => { throw new Error("停止后端超时"); };
  assert.equal(await confirmDesktopQuit(f.options), false);
  assert.match(f.prompts[1].detail, /后台可能在完成后退出/);
  assert.equal(await confirmDesktopQuit(f.options), true);
});

test("an attached desktop can exit without probing or stopping the shared service", async () => {
  const f = fixture([1]); f.backend.owned = false;
  assert.equal(await confirmDesktopQuit(f.options), true);
  assert.equal(f.stops, 0);
  assert.equal(f.prompts.length, 1);
});

test("desktop-only recovery never bypasses staged native update protection", async () => {
  let checks = 0;
  const f = fixture([2, 1], { updater: { assertQuitSafe: async () => {
    if (++checks === 2) throw new Error("bundled backend still live");
  } } });
  f.backend.stop = async () => { throw new Error("save refused"); };
  await assert.rejects(confirmDesktopQuit(f.options), /bundled backend still live/);
});
