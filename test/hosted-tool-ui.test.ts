import test from "node:test";
import assert from "node:assert/strict";
import { toolHeight, toolPresentation, notification } from "../src/host/client/hosted/tool-ui.ts";
import { managementConfirmation } from "../src/host/client/hosted/confirmation.ts";

test("frame UI boundary rejects malformed and unbounded layout/notification data", () => {
  for (const height of [-1, NaN, Infinity, 4097, "240", undefined]) assert.throws(() => toolHeight({ height }));
  assert.equal(toolHeight({ height: 0 }), 1); assert.equal(toolHeight({ height: 72.1 }), 73);
  assert.deepEqual(toolPresentation({ title: "Map preview" }), { title: "Map preview" });
  for (const title of [null, "", " ", "a".repeat(161)]) assert.throws(() => toolPresentation({ title }));
  assert.deepEqual(notification({ message: "Saved", level: "info" }), { message: "Saved", level: "info" });
  assert.throws(() => notification({ message: {}, level: "error" }));
  assert.throws(() => notification({ message: "a".repeat(4001), level: "info" }));
  for (const level of [undefined, "warning", new String("info"), 1]) assert.throws(() => notification({ message: "Status", level }));
});

test("management confirms the actual operation, retaining save failure and data guarantees", () => {
  for (const locale of ["zh", "en"] as const) {
    const copies = ["uninstall", "disable", "update"].map(operation => managementConfirmation(operation as "uninstall" | "disable" | "update", locale, "Example"));
    assert.equal(new Set(copies.map(copy => copy.title)).size, 3);
    assert.equal(new Set(copies.map(copy => copy.confirm)).size, 3);
    for (const copy of copies) { assert.match(copy.title, /Example/); assert.match(copy.description, locale === "zh" ? /保存失败/ : /failed save/); }
    assert.match(copies[2].description, locale === "zh" ? /撤销\/重做/ : /Undo\/redo/);
  }
});
