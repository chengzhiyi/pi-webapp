import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { DesktopConnectionError, localAddress } from "../backend.mjs";
import { connectBackend } from "../connect.mjs";
import { localize, setDesktopLocale } from "../locale.mjs";
import { confirmDesktopQuit } from "../quit.mjs";

const address = "http://127.0.0.1:4321/#aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const builder = createRequire(import.meta.url)("../builder.cjs");

test("the locale helper ships inside the desktop application", () => {
  assert.ok(builder.files.includes("locale.mjs"));
});

test("native text follows the operating-system locale", () => {
  try {
    for (const value of ["en", "en-US", "ru-RU", "de_DE", "", null]) {
      setDesktopLocale(value);
      assert.equal(localize("编辑", "Edit"), "Edit");
    }
    for (const value of ["zh", "zh-CN", "zh-Hans-CN"]) {
      setDesktopLocale(value);
      assert.equal(localize("编辑", "Edit"), "编辑");
    }
  } finally { setDesktopLocale("zh"); }
});

test("English locale translates quit confirmation buttons", async () => {
  setDesktopLocale("en-US");
  try {
    const prompts = [];
    const confirmed = await confirmDesktopQuit({
      appName: "pi",
      backend: { owned: true, stop: async () => {} },
      showMessageBox: async options => { prompts.push(options); return { response: 1 }; },
    });
    assert.equal(confirmed, true);
    assert.equal(prompts[0].title, "Quit pi");
    assert.deepEqual(prompts[0].buttons, ["Cancel", "Close Window, Keep Service Running", "Stop Service and Quit"]);
  } finally { setDesktopLocale("zh"); }
});

test("English locale translates connection recovery and backend errors", async () => {
  setDesktopLocale("en-US");
  try {
    assert.throws(() => localAddress("https://example.test"), /invalid local address/);
    const prompts = [];
    const error = new DesktopConnectionError("version-incompatible", "Incompatible service", address);
    const result = await connectBackend(
      { connect: async () => { throw error; } },
      {
        showMessageBox: async options => { prompts.push(options); return { response: 3 }; },
        openExternal: async () => assert.fail("must not open the browser when quitting"),
        checkDesktopUpdates: async () => assert.fail("must not check updates when quitting"),
      },
    );
    assert.equal(result, null);
    assert.equal(prompts[0].title, "Cannot connect to the existing service");
    assert.deepEqual(prompts[0].buttons, ["Check Again", "Continue in Browser", "Check for Desktop Updates", "Quit"]);
  } finally { setDesktopLocale("zh"); }
});
