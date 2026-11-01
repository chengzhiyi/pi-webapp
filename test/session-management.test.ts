import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { WorkspaceSessions } from "../src/host/server/sessions/workspace-sessions.ts";
import { moveSessionToTrash, sessionTrashDirectory } from "../src/host/server/sessions/session-trash.ts";
import { sessionTitle } from "../src/host/server/sessions/view.ts";
import { startBridge } from "../src/host/server/transport/bridge.ts";

const webRoot = fileURLToPath(new URL("../web/dist/", import.meta.url));

test("untitled chats carry no server-side placeholder, so the browser can localize it", () => {
  assert.equal(sessionTitle(undefined, []), "");
  assert.equal(sessionTitle("  ", [{ id: "u", role: "user", timestamp: "", blocks: [{ kind: "text", text: "Fix   the\nbuild" }] }]), "Fix the build");
  assert.equal(sessionTitle(" Release notes ", []), "Release notes");
});

test("deleted session files move into pi-web/trash and a missing file counts as deleted", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-trash-"));
  try {
    const file = join(root, "sessions", "2026_abc.jsonl");
    await mkdir(join(root, "sessions"));
    await writeFile(file, "{\"type\":\"session\"}\n");
    const moved = await moveSessionToTrash(file, root);
    assert.ok(moved?.startsWith(sessionTrashDirectory(root)));
    assert.equal(await readFile(moved!, "utf8"), "{\"type\":\"session\"}\n");
    assert.deepEqual(await readdir(join(root, "sessions")), []);
    assert.equal(await moveSessionToTrash(file, root), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("blank chats are flagged and reused, renames persist and discard closes the runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-session-mgmt-"));
  const cwd = join(root, "workspace");
  const savedAgent = process.env.PI_CODING_AGENT_DIR, savedDev = process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent"); process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS = "";
  await mkdir(cwd);
  const host = new WorkspaceSessions(() => {}, () => undefined);
  try {
    assert.equal(await host.reuseBlank(cwd), false, "nothing to reuse before the first chat");
    await host.open(cwd, "new");
    const blankId = host.snapshot().sessionId;
    assert.equal(host.retainedSessions().find(item => item.sessionId === blankId)?.blank, true);
    assert.equal(await host.reuseBlank(cwd), true);
    assert.equal(host.snapshot().sessionId, blankId, "reuse keeps the same untouched chat");

    host.session!.sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() });
    assert.equal(host.retainedSessions().find(item => item.sessionId === blankId)?.blank, false);
    assert.equal(await host.reuseBlank(cwd), false, "a chat with a message is never reused as new");

    assert.equal(host.rename(blankId, "Renamed"), true);
    assert.equal(host.snapshot().name, "Renamed");
    assert.equal(host.rename("not-retained", "x"), false);

    const discarded = await host.discard(blankId);
    assert.equal(discarded?.wasActive, true);
    assert.equal(host.retainedSessions().length, 0, "discard closes and forgets the runtime");
    assert.equal(host.hasSession(discarded!.cwd, blankId), false);
    assert.equal(await host.discard(blankId), null);
  } finally {
    await host.dispose();
    if (savedAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedAgent;
    if (savedDev === undefined) delete process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS; else process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS = savedDev;
    await rm(root, { recursive: true, force: true });
  }
});

test("renaming a saved chat appends Pi's own session_info entry", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-session-name-"));
  try {
    const manager = SessionManager.create(root, join(root, "sessions"));
    manager.appendMessage({ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() });
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "hello" }], api: "openai-completions", provider: "x", model: "y", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
    const file = manager.getSessionFile()!;
    SessionManager.open(file).appendSessionInfo("Weekly report");
    assert.equal(SessionManager.open(file).getSessionName(), "Weekly report");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rename and delete routes validate input, report unsupported hosts and dispatch", async () => {
  const calls: string[] = [];
  const base = {
    snapshot: () => ({ schemaVersion: 1 as const, sessionId: "session-a", cwd: "/tmp/pi-project", name: "", model: null, thinkingLevel: null, thinkingLevels: [], idle: true, contextUsage: null, messages: [], pluginEntries: [] }),
    send() {}, abort() {}, async newSession() {},
    workspaces: async () => ({ items: [], activeId: null, sessions: [] }),
    async addWorkspace() {}, async selectWorkspace() {}, async newSessionInWorkspace() {}, async removeWorkspace() {}, async selectSession() {},
    models: () => [], async setModel() {}, async setThinkingLevel() {},
    config: () => ({ projectTrusted: true, global: { packages: [], extensions: [], skills: [] }, project: { packages: [], extensions: [], skills: [] }, installed: { packages: [], extensions: [], skills: [] } }),
    async updateConfig() { return this.config(); },
  };
  for (const supported of [false, true]) {
    const bridge = await startBridge(supported ? { ...base,
      async renameSession(workspaceId: string, id: string, path: string, name: string) { calls.push(`rename:${workspaceId}:${id}:${path}:${name}`); },
      async deleteSession(workspaceId: string, id: string, path: string) { calls.push(`delete:${workspaceId}:${id}:${path}`); },
    } : base, webRoot);
    try {
      const url = new URL(bridge.url);
      const headers = { Authorization: `Bearer ${url.hash.slice(1)}`, "Content-Type": "application/json", Origin: url.origin };
      const post = (path: string, body: object) => fetch(`${url.origin}${path}`, { method: "POST", headers, body: JSON.stringify({ sessionId: "session-a", ...body }) });
      const target = { workspaceId: "w", id: "s", path: "/tmp/s.jsonl" };
      assert.equal((await post("/api/session/rename", { ...target, name: 1 })).status, 400);
      assert.equal((await post("/api/session/delete", { id: "s", path: "" })).status, 400);
      assert.equal((await post("/api/session/rename", { ...target, name: "New name" })).status, supported ? 202 : 501);
      assert.equal((await post("/api/session/delete", target)).status, supported ? 202 : 501);
    } finally { await bridge.close(); }
  }
  assert.deepEqual(calls, ["rename:w:s:/tmp/s.jsonl:New name", "delete:w:s:/tmp/s.jsonl"]);
});
