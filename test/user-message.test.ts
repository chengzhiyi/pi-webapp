import assert from "node:assert/strict";
import test from "node:test";
import { displayUserMessage } from "../shared/user-message.ts";

test("hides only pi-web's stored attachment paths while retaining filenames", () => {
  const root = `/tmp/pi-web/attachments/${"a".repeat(64)}`;
  const input = `图片内容\n\n附件 "图像.png"：${root}/图像.png\n\n附件 "report.xlsx"：${root}/report.xlsx`;
  assert.deepEqual(displayUserMessage(input), { text: "图片内容", attachments: [
    { name: "图像.png", image: true }, { name: "report.xlsx", image: false },
  ] });
  assert.deepEqual(displayUserMessage("请阅读\n\n附件 \"x\"：/tmp/other/x"), { text: "请阅读\n\n附件 \"x\"：/tmp/other/x", attachments: [] });
});
