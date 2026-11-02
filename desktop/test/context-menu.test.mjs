import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { showContextMenu } from "../context-menu.mjs";
import { setDesktopLocale } from "../locale.mjs";

const builder = createRequire(import.meta.url)("../builder.cjs");

function fixture() {
  const state = { template: null, popup: null, copied: "" };
  const window = { id: "main-window" };
  return { state, window, dependencies: {
    Menu: { buildFromTemplate(items) {
      state.template = items;
      return { popup(options) { state.popup = options; } };
    } },
    clipboard: { writeText(value) { state.copied = value; } },
    window,
  } };
}

const roles = template => template.filter(item => item.role).map(item => item.role);

test("the context menu ships inside the desktop application", () => {
  assert.ok(builder.files.includes("context-menu.mjs"));
});

test("links offer a native copy-link action without opening or navigating", () => {
  setDesktopLocale("en-US");
  try {
    const f = fixture();
    const url = "https://example.test/docs?q=pi";
    assert.equal(showContextMenu({ linkURL: url, isEditable: false, selectionText: "" }, f.dependencies), true);
    assert.equal(f.state.template[0].label, "Copy Link Address");
    assert.equal(f.state.popup.window, f.window);
    f.state.template[0].click();
    assert.equal(f.state.copied, url);
  } finally { setDesktopLocale("zh"); }
});

test("selected text offers copy, including alongside a link action", () => {
  const f = fixture();
  assert.equal(showContextMenu({ linkURL: "https://example.test", isEditable: false, selectionText: "selected" }, f.dependencies), true);
  assert.deepEqual(roles(f.state.template), ["copy"]);
  assert.equal(f.state.template[1].type, "separator");
});

test("editable content exposes the standard editing actions", () => {
  const f = fixture();
  assert.equal(showContextMenu({ linkURL: "", isEditable: true, selectionText: "draft" }, f.dependencies), true);
  assert.deepEqual(roles(f.state.template), ["undo", "redo", "cut", "copy", "paste", "selectAll"]);
});

test("plain non-editable content does not open an empty menu", () => {
  const f = fixture();
  assert.equal(showContextMenu({ linkURL: "", isEditable: false, selectionText: "" }, f.dependencies), false);
  assert.equal(f.state.template, null);
  assert.equal(f.state.popup, null);
});
