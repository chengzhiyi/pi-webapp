import assert from "node:assert/strict";
import test from "node:test";
import { fileContext } from "../src/plugins/builtin/files/client/file-context.ts";
import { displayUserMessage, withWorkspaceContext } from "../src/contracts/user-message.ts";

test("a Files tab tells the agent which file and lines are in view", () => {
  assert.equal(fileContext("/w", undefined, null), null);
  assert.deepEqual(fileContext("/w/", "src/app.ts", null), { detail: "app.ts", reference: "Open file: src/app.ts (absolute: /w/src/app.ts)." });
  assert.deepEqual(fileContext("/w", "package.json", { from: 55, to: 80 }), {
    detail: "package.json · L55–80", reference: "Open file: package.json (absolute: /w/package.json). Selected lines 55–80.",
  });
  assert.equal(fileContext("/w", "a.md", { from: 3, to: 3 })!.detail, "a.md · L3");
});

test("the tab reference carries the reported detail and reference and round-trips through display", () => {
  const context = { title: "Files", kind: "files", contentId: "workspace", plugin: "files", detail: "package.json · L55–80", reference: "Open file: package.json. Selected lines 55–80." };
  const sent = withWorkspaceContext("How many lines?", context);
  assert.match(sent, /act on it in place instead of creating something new\.$/u);
  assert.deepEqual(displayUserMessage(sent), { text: "How many lines?", attachments: [], context });
  // Older prompts without the guidance sentence still parse.
  assert.deepEqual(displayUserMessage(`Hi\n\n[pi-web workspace tab in view] ${JSON.stringify({ title: "T", kind: "k", contentId: "c" })}`).context, { title: "T", kind: "k", contentId: "c" });
});
