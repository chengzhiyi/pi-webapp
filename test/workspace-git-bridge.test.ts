import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { startBridge, type BridgeHost } from "../src/host/server/transport/bridge.ts";
import type { SessionView } from "../src/host/server/sessions/view.ts";
import { isContentOperation, safeFields } from "../src/contracts/telemetry.ts";

test("Git endpoints enforce authentication, origin, session and read-only paths, including mid-read switches", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-git-api-"));
  const session: SessionView = { schemaVersion: 1, sessionId: "git-a", cwd, name: "Git", model: null, thinkingLevel: null,
    thinkingLevels: [], idle: true, contextUsage: null, messages: [], pluginEntries: [] };
  const host: BridgeHost = {
    snapshot: () => session, models: () => [], send() {}, abort() {}, async newSession() {}, async setModel() {}, async setThinkingLevel() {},
    config: () => ({ projectTrusted: false, global: { packages: [], extensions: [], skills: [] }, project: { packages: [], extensions: [], skills: [] }, installed: { packages: [], extensions: [], skills: [] } }),
    async updateConfig() { return this.config(); }, async workspaces() { return { items: [], activeId: null, sessions: [] }; },
    async addWorkspace() {}, async selectWorkspace() {}, async newSessionInWorkspace() {}, async removeWorkspace() {}, async selectSession() {},
  };
  const bridge = await startBridge(host, fileURLToPath(new URL("../web/dist/", import.meta.url)));
  try {
    await promisify(execFile)("git", ["init", "-b", "main"], { cwd });
    await writeFile(join(cwd, "new.txt"), "read only\n");
    const url = new URL(bridge.url);
    const headers = { Authorization: `Bearer ${url.hash.slice(1)}`, "Content-Type": "application/json", Origin: url.origin };
    const request = (route: string, body: object = {}, selected = headers) => fetch(`${url.origin}/api/workspace/git/${route}`, { method: "POST", headers: selected, body: JSON.stringify({ sessionId: "git-a", ...body }) });
    for (const route of ["status", "diff"]) {
      const body = { path: "new.txt", area: "untracked" };
      assert.equal((await request(route, body, { ...headers, Authorization: "" })).status, 401);
      assert.equal((await request(route, body, { ...headers, Origin: "https://other.example" })).status, 403);
      assert.equal((await request(route, { ...body, sessionId: "stale" })).status, 409);
      const response = await request(route, body);
      assert.equal(response.status, 200); assert.match(response.headers.get("cache-control")!, /no-store/);
      assert.equal(isContentOperation(`/api/workspace/git/${route}`), true);
      assert.equal(safeFields({ route: `/api/workspace/git/${route}` }).route, `/api/workspace/git/${route}`);
    }
    for (const body of [{ path: 123, area: "staged" }, { path: "new.txt", area: "reset" }, {}]) assert.equal((await request("diff", body)).status, 400);
    for (const path of ["../outside", "/etc/passwd", "a/../../outside", "a\0b", "C:\\private"]) assert.equal((await request("diff", { path, area: "staged" })).status, 403);
    const patch = await (await request("diff", { path: "new.txt", area: "untracked" })).json();
    assert.match(patch.patch, /\+read only/);
    await promisify(execFile)("git", ["add", "."], { cwd });
    await promisify(execFile)("git", ["-c", "user.name=API Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "initial"], { cwd });
    const history = await (await request("history")).json();
    const hash = history.commits[0].hash;
    for (const [route, body] of [["history", {}], ["commit-detail", { hash }], ["commit-diff", { hash, path: "new.txt" }]] as const) {
      assert.equal((await request(route, body)).status, 200);
      assert.equal((await request(route, body, { ...headers, Authorization: "" })).status, 401);
      assert.equal((await request(route, body, { ...headers, Origin: "https://other.example" })).status, 403);
      assert.equal((await request(route, { ...body, sessionId: "stale" })).status, 409);
      assert.equal(isContentOperation(`/api/workspace/git/${route}`), true);
      assert.equal(safeFields({ route: `/api/workspace/git/${route}` }).route, `/api/workspace/git/${route}`);
    }
    for (const [route, body, status] of [["history", { limit: "50" }, 400], ["history", { cursor: {} }, 400], ["history", { cursor: "bad" }, 400], ["commit-detail", { hash: "--all" }, 400], ["commit-detail", { hash, parentIndex: 999 }, 400], ["commit-detail", { hash: "0".repeat(40) }, 404], ["commit-diff", { hash, path: "../outside" }, 403], ["commit-diff", { hash, path: "missing" }, 404]] as const) assert.equal((await request(route, body)).status, status);
    assert.equal((await request("commit")).status, 404);
    assert.equal((await fetch(`${url.origin}/api/workspace/git/diff`, { method: "PUT", headers, body: JSON.stringify({ sessionId: "git-a", path: "new.txt" }) })).status, 404);
    assert.equal(await readFile(join(cwd, "new.txt"), "utf8"), "read only\n");
    let reads = 0;
    host.snapshot = () => ++reads === 1 ? session : { ...session, sessionId: "git-b" };
    assert.equal((await request("status")).status, 409);
    for (const [route, body] of [["history", {}], ["commit-detail", { hash }], ["commit-diff", { hash, path: "new.txt" }]] as const) {
      reads = 0; assert.equal((await request(route, body)).status, 409);
    }
  } finally { await bridge.close(); await rm(cwd, { recursive: true, force: true }); }
});
