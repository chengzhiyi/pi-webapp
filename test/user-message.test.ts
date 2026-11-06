import assert from "node:assert/strict";
import test from "node:test";
import { displayUserMessage, withWorkspaceContext } from "../src/contracts/user-message.ts";

test("hides only pi-web's stored attachment paths while retaining filenames", () => {
  const root = `/tmp/pi-web/attachments/${"a".repeat(64)}`;
  const input = `图片内容\n\n附件 "图像.png"：${root}/图像.png\n\n附件 "report.xlsx"：${root}/report.xlsx`;
  assert.deepEqual(displayUserMessage(input), { text: "图片内容", attachments: [
    { name: "图像.png", image: true }, { name: "report.xlsx", image: false },
  ] });
  assert.deepEqual(displayUserMessage("请阅读\n\n附件 \"x\"：/tmp/other/x"), { text: "请阅读\n\n附件 \"x\"：/tmp/other/x", attachments: [] });
});

test("hides the floating composer's workspace tab reference and keeps it for display", () => {
  const root = `/tmp/pi-web/attachments/${"b".repeat(64)}`;
  const context = { title: "Excalidraw", kind: "plugin", contentId: "drawing-1", plugin: "excalidraw" };
  const sent = withWorkspaceContext("Tidy this layout", context);
  assert.deepEqual(displayUserMessage(sent), { text: "Tidy this layout", attachments: [], context });
  assert.deepEqual(displayUserMessage(`${sent}\n\n附件 "a.png"：${root}/a.png`), { text: "Tidy this layout", attachments: [{ name: "a.png", image: true }], context });
  assert.equal(withWorkspaceContext("Plain", null), "Plain");
  // A malformed or mid-text marker is ordinary user text.
  const typed = "[pi-web workspace tab in view] {broken";
  assert.deepEqual(displayUserMessage(`Note\n\n${typed}`), { text: `Note\n\n${typed}`, attachments: [] });
  assert.deepEqual(displayUserMessage(`${sent}\n\nmore`).text, `${sent}\n\nmore`);
});
