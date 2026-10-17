import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { startBridge, type BridgeHost } from "../extension/bridge.ts";
import type { SessionView } from "../extension/view.ts";

test("workspace file endpoints require the active session, token and same origin and never write files", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-files-api-"));
  let session: SessionView = { schemaVersion: 1, sessionId: "files-a", cwd, name: "Files", model: null, thinkingLevel: null,
    thinkingLevels: [], idle: true, contextUsage: null, messages: [], pluginEntries: [] };
  const host: BridgeHost = {
    snapshot: () => session, models: () => [], send() {}, abort() {}, async newSession() {}, async setModel() {}, async setThinkingLevel() {},
    config: () => ({ projectTrusted: false, global: { packages: [], extensions: [], skills: [] }, project: { packages: [], extensions: [], skills: [] }, installed: { packages: [], extensions: [], skills: [] } }),
    async updateConfig() { return this.config(); }, async workspaces() { return { items: [], activeId: null, sessions: [] }; },
    async addWorkspace() {}, async selectWorkspace() {}, async newSessionInWorkspace() {}, async removeWorkspace() {}, async selectSession() {},
  };
  const bridge = await startBridge(host, fileURLToPath(new URL("../web/dist/", import.meta.url)));
  try {
    await writeFile(join(cwd, "readme.md"), "# Local only\n");
    const url = new URL(bridge.url);
    const headers = { Authorization: `Bearer ${url.hash.slice(1)}`, "Content-Type": "application/json", Origin: url.origin };
    const request = (route: string, body: object, selected = headers) => fetch(`${url.origin}/api/workspace/files/${route}`, { method: "POST", headers: selected, body: JSON.stringify({ sessionId: "files-a", ...body }) });
    for (const [route, path] of [["list", ""], ["preview", "readme.md"]] as const) {
      assert.equal((await request(route, { path }, { ...headers, Authorization: "" })).status, 401);
      assert.equal((await request(route, { path }, { ...headers, Origin: "https://other.example" })).status, 403);
      assert.equal((await request(route, { path, sessionId: "stale" })).status, 409);
      assert.equal((await request(route, { path: 123 })).status, 400);
      assert.equal((await request(route, { path: "../outside" })).status, 403);
      assert.equal((await request(route, { path: "missing" })).status, 404);
      assert.equal((await request(route, { path, sessionId: "files-a" })).status, 200);
    }
    const preview = await (await request("preview", { path: "readme.md" })).json();
    assert.equal(preview.kind, "text");
    assert.equal(preview.text, "# Local only\n");
    assert.match((await request("preview", { path: "readme.md" })).headers.get("cache-control")!, /no-store/);
    const error = await (await request("preview", { path: "missing" })).json();
    assert.equal(error.errorCode, "validation_error");
    assert.equal(error.errorId, undefined);
    assert.equal((await fetch(`${url.origin}/api/workspace/files/preview`, { method: "PUT", headers, body: JSON.stringify({ sessionId: "files-a", path: "readme.md", text: "changed" }) })).status, 404);
    // Simulate a switch between the initial snapshot and the completed disk read.
    let reads = 0;
    host.snapshot = () => ++reads === 1 ? session : { ...session, sessionId: "files-b" };
    assert.equal((await request("preview", { path: "readme.md" })).status, 409);
  } finally { await bridge.close(); await rm(cwd, { recursive: true, force: true }); }
});
