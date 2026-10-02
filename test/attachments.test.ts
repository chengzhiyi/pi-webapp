import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { startBridge } from "../extension/bridge.ts";
import { fileLeafName } from "../extension/attachments.ts";

const webRoot = fileURLToPath(new URL("../web/dist/", import.meta.url));

test("filename sanitizer keeps uploaded names inside the attachment store", () => {
  assert.equal(fileLeafName("C:\\private\\notes.txt"), "notes.txt");
  assert.equal(fileLeafName("../../CON.txt"), "_CON.txt");
  assert.equal(fileLeafName("../a<b>.txt"), "a_b_.txt");
});

test("uploads a file, sends its saved path, and rejects stale or foreign receipts", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-upload-"));
  const originalDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  const sent: Array<{ text: string; images: unknown[] }> = [];
  const bridge = await startBridge({
    snapshot: () => ({ schemaVersion: 1, sessionId: "session-a", cwd: root, name: "test", model: null, thinkingLevel: null, thinkingLevels: [], idle: true, contextUsage: null, messages: [], pluginEntries: [] }),
    models: () => [], async setModel() {}, async setThinkingLevel() {},
    config: () => ({ projectTrusted: true, global: { packages: [], extensions: [], skills: [] }, project: { packages: [], extensions: [], skills: [] }, installed: { packages: [], extensions: [], skills: [] } }),
    async updateConfig() { return this.config(); },
    send(_sessionId, text, images) { sent.push({ text, images: images ?? [] }); },
    abort() {}, async newSession() {}, workspaces: async () => ({ items: [], activeId: null, sessions: [] }),
    async addWorkspace() {}, async selectWorkspace() {}, async newSessionInWorkspace() {}, async removeWorkspace() {}, async selectSession() {},
  }, webRoot);
  try {
    const url = new URL(bridge.url);
    const headers = { Authorization: `Bearer ${url.hash.slice(1)}`, Origin: url.origin };
    const upload = (sessionId: string, name: string, body: string, extraHeaders = {}) => fetch(`${url.origin}/api/attachment?sessionId=${sessionId}&name=${encodeURIComponent(name)}`, {
      method: "POST", headers: { ...headers, "Content-Type": "text/plain", ...extraHeaders }, body,
    });
    assert.equal((await upload("session-b", "test.txt", "wrong")).status, 409);
    assert.equal((await upload("session-a", "test.txt", "wrong", { Origin: "https://elsewhere.example" })).status, 403);
    const response = await upload("session-a", "../notes.txt", "UPLOAD_OK");
    assert.equal(response.status, 201);
    const receipt = await response.json() as { id: string; name: string; bytes: number };
    assert.equal(receipt.name, "notes.txt");
    assert.equal(receipt.bytes, 9);
    const chinese = await upload("session-a", "微信图片.png", "valid filename");
    assert.equal(chinese.status, 201);
    assert.equal((await chinese.json() as { name: string }).name, "微信图片.png");
    const send = (ids: string[]) => fetch(`${url.origin}/api/message`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "session-a", text: "Read this", attachments: ids }),
    });
    assert.equal((await send(["unknown"])).status, 400);
    const disposable = await upload("session-a", "remove.txt", "discard me");
    const disposableId = (await disposable.json() as { id: string }).id;
    const removed = await fetch(`${url.origin}/api/attachment/remove`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "session-a", id: disposableId }),
    });
    assert.equal(removed.status, 202);
    assert.equal((await send([disposableId])).status, 400);
    assert.equal((await send([receipt.id])).status, 202);
    assert.equal(sent.length, 1);
    assert.match(sent[0]!.text, /Read this\n\n附件 "notes\.txt"：/);
    const path = sent[0]!.text.split("：").at(-1)!;
    assert.equal(await readFile(path, "utf8"), "UPLOAD_OK");
    assert.deepEqual(sent[0]!.images, []);
    assert.equal((await send([receipt.id])).status, 400);
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lX8AAAAASUVORK5CYII=", "base64");
    const imageResponse = await fetch(`${url.origin}/api/attachment?sessionId=session-a&name=picture.png`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/octet-stream" }, body: png,
    });
    assert.equal(imageResponse.status, 201);
    const imageReceipt = await imageResponse.json() as { id: string };
    assert.equal((await send([imageReceipt.id])).status, 202);
    assert.deepEqual(sent[1]!.images, [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }]);
  } finally {
    await bridge.close();
    if (originalDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalDir;
    await rm(root, { recursive: true, force: true });
  }
});
