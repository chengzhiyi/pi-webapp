import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startBridge } from "../extension/bridge.ts";
import type { SessionView } from "../extension/view.ts";

const webRoot = fileURLToPath(new URL("../web/dist/", import.meta.url));

function fixture(): SessionView {
  return {
    schemaVersion: 1,
    sessionId: "session-a",
    cwd: "/tmp/pi-project",
    name: "当前会话",
    model: "example/model",
    thinkingLevel: "medium",
    thinkingLevels: ["off", "medium"],
    idle: true,
    contextUsage: null,
    messages: [],
  };
}

const capabilities = {
  workspaces: async () => ({ items: [], activeId: null, sessions: [] }),
  async addWorkspace() {},
  async selectWorkspace() {},
  async newSessionInWorkspace() {},
  async removeWorkspace() {},
  async selectSession() {},
  models: () => [{ provider: "example", id: "model", name: "Example model" }],
  async setModel() {},
  async setThinkingLevel() {},
  config: () => ({ projectTrusted: true, global: { packages: [], extensions: [], skills: [] }, project: { packages: [], extensions: [], skills: [] }, installed: { packages: [], extensions: [], skills: [] } }),
  async updateConfig() { return this.config(); },
};

test("requires the token to read the current session or send a message", async () => {
  const sent: string[] = [];
  const bridge = await startBridge({
    ...capabilities,
    snapshot: fixture,
    send(_sessionId, text) { sent.push(text); },
    abort() {},
    async newSession() {},
  }, webRoot);
  try {
    assert.equal(bridge.protocolVersion, 4);
    const url = new URL(bridge.url);
    const token = url.hash.slice(1);
    const unauthorized = await fetch(`${url.origin}/api/session`);
    assert.equal(unauthorized.status, 401);
    const blockedPost = await fetch(`${url.origin}/api/message`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "session-a", text: "must not send" }),
    });
    assert.equal(blockedPost.status, 401);
    assert.deepEqual(sent, []);

    const snapshot = await fetch(`${url.origin}/api/session`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(snapshot.status, 200);
    assert.match(snapshot.headers.get("content-security-policy") ?? "", /img-src 'self' data: blob:/);
    assert.equal((await snapshot.json()).sessionId, "session-a");
    const accepted = await fetch(`${url.origin}/api/message`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Origin: url.origin },
      body: JSON.stringify({ sessionId: "session-a", text: "hello" }),
    });
    assert.equal(accepted.status, 202);
    assert.deepEqual(sent, ["hello"]);
  } finally {
    await bridge.close();
  }
});

test("update endpoints require authorization and restart only after a validated request", async () => {
  let restarts = 0;
  let idle = true;
  const bridge = await startBridge({
    ...capabilities, snapshot: () => ({ ...fixture(), idle }), send() {}, abort() {}, async newSession() {},
    selfUpdate: {
      async check() { return { current: "0.1.0", latest: "0.2.0", available: true, canRestart: true }; },
      async runningVersion() { return "0.1.0"; },
      async prepare() { return { version: "0.2.0", launcher: "/validated/launcher.mjs" }; },
      async requestRestart() { restarts++; },
    },
  }, webRoot);
  try {
    const url = new URL(bridge.url);
    const headers = { Authorization: `Bearer ${url.hash.slice(1)}`, "Content-Type": "application/json", Origin: url.origin };
    assert.equal((await fetch(`${url.origin}/api/update`)).status, 401);
    assert.equal((await fetch(`${url.origin}/api/update`, { headers })).status, 200);
    assert.deepEqual(await (await fetch(`${url.origin}/api/update/version`, { headers })).json(), { current: "0.1.0" });
    const stale = await fetch(`${url.origin}/api/update`, { method: "POST", headers, body: JSON.stringify({ sessionId: "other" }) });
    assert.equal(stale.status, 409);
    assert.equal(restarts, 0);
    idle = false;
    const busy = await fetch(`${url.origin}/api/update`, { method: "POST", headers, body: JSON.stringify({ sessionId: "session-a" }) });
    assert.equal(busy.status, 409);
    idle = true;
    const accepted = await fetch(`${url.origin}/api/update`, { method: "POST", headers, body: JSON.stringify({ sessionId: "session-a" }) });
    assert.equal(accepted.status, 202);
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(restarts, 1);
  } finally { await bridge.close(); }
});

test("supervised restart preserves the browser port and token", async () => {
  const host = { ...capabilities, snapshot: fixture, send() {}, abort() {}, async newSession() {} };
  const first = await startBridge(host, webRoot);
  const address = new URL(first.url);
  await first.close();
  const beforePort = process.env.PI_WEBAPP_RESTART_PORT;
  const beforeToken = process.env.PI_WEBAPP_RESTART_TOKEN;
  process.env.PI_WEBAPP_RESTART_PORT = address.port;
  process.env.PI_WEBAPP_RESTART_TOKEN = address.hash.slice(1);
  try {
    const restarted = await startBridge(host, webRoot);
    try { assert.equal(restarted.url, first.url); }
    finally { await restarted.close(); }
  } finally {
    if (beforePort === undefined) delete process.env.PI_WEBAPP_RESTART_PORT;
    else process.env.PI_WEBAPP_RESTART_PORT = beforePort;
    if (beforeToken === undefined) delete process.env.PI_WEBAPP_RESTART_TOKEN;
    else process.env.PI_WEBAPP_RESTART_TOKEN = beforeToken;
  }
});

test("serves historical message images only for the active authenticated session", async () => {
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const bridge = await startBridge({
    ...capabilities,
    snapshot: fixture,
    image(_sessionId, messageId, index) { return messageId === "user-1" && index === 1 ? { data: bytes, mimeType: "image/png" } : null; },
    send() {}, abort() {}, async newSession() {},
  }, webRoot);
  try {
    const url = new URL(bridge.url);
    const imageUrl = `${url.origin}/api/image?sessionId=session-a&messageId=user-1&index=1`;
    assert.equal((await fetch(imageUrl)).status, 401);
    const headers = { Authorization: `Bearer ${url.hash.slice(1)}` };
    assert.equal((await fetch(imageUrl.replace("session-a", "session-b"), { headers })).status, 409);
    assert.equal((await fetch(imageUrl.replace("index=1", "index=2"), { headers })).status, 404);
    const response = await fetch(imageUrl, { headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  } finally { await bridge.close(); }
});

test("lists Pi commands and compacts only the active authenticated session", async () => {
  const compacted: string[] = [];
  const bridge = await startBridge({
    ...capabilities,
    snapshot: fixture,
    commands: () => [{ name: "skill:review", description: "Review code" }],
    compact(sessionId) { if (sessionId !== "session-a") throw new Error("会话已切换"); compacted.push(sessionId); },
    send() {}, abort() {}, async newSession() {},
  }, webRoot);
  try {
    const url = new URL(bridge.url);
    const headers = { Authorization: `Bearer ${url.hash.slice(1)}`, "Content-Type": "application/json", Origin: url.origin };
    assert.equal((await fetch(`${url.origin}/api/commands`)).status, 401);
    const commands = await fetch(`${url.origin}/api/commands`, { headers });
    assert.deepEqual(await commands.json(), [{ name: "skill:review", description: "Review code" }]);
    const stale = await fetch(`${url.origin}/api/compact`, { method: "POST", headers, body: JSON.stringify({ sessionId: "session-b" }) });
    assert.equal(stale.status, 409);
    const accepted = await fetch(`${url.origin}/api/compact`, { method: "POST", headers, body: JSON.stringify({ sessionId: "session-a" }) });
    assert.equal(accepted.status, 202);
    assert.deepEqual(compacted, ["session-a"]);
  } finally { await bridge.close(); }
});

test("rejects wrong origins and stale session targets", async () => {
  let created = 0;
  const bridge = await startBridge({
    ...capabilities,
    snapshot: fixture,
    send(sessionId) { if (sessionId !== "session-a") throw new Error("会话已切换"); },
    abort(sessionId) { if (sessionId !== "session-a") throw new Error("会话已切换"); },
    async newSession(sessionId) { if (sessionId !== "session-a") throw new Error("会话已切换"); created++; },
  }, webRoot);
  try {
    const url = new URL(bridge.url);
    const headers = { Authorization: `Bearer ${url.hash.slice(1)}`, "Content-Type": "application/json" };
    const wrongOrigin = await fetch(`${url.origin}/api/abort`, {
      method: "POST", headers: { ...headers, Origin: "https://example.com" }, body: JSON.stringify({ sessionId: "session-a" }),
    });
    assert.equal(wrongOrigin.status, 403);
    const stale = await fetch(`${url.origin}/api/message`, {
      method: "POST", headers, body: JSON.stringify({ sessionId: "session-b", text: "hello" }),
    });
    assert.equal(stale.status, 409);
    const staleNewSession = await fetch(`${url.origin}/api/new-session`, {
      method: "POST", headers, body: JSON.stringify({ sessionId: "session-b" }),
    });
    assert.equal(staleNewSession.status, 409);
    const newSession = await fetch(`${url.origin}/api/new-session`, {
      method: "POST", headers, body: JSON.stringify({ sessionId: "session-a" }),
    });
    assert.equal(newSession.status, 202);
    assert.equal(created, 1);
  } finally {
    await bridge.close();
  }
});

test("streams the current snapshot and later events", async () => {
  const bridge = await startBridge({ ...capabilities, snapshot: fixture, send() {}, abort() {}, async newSession() {} }, webRoot);
  const url = new URL(bridge.url);
  const response = await fetch(`${url.origin}/api/events`, {
    headers: { Authorization: `Bearer ${url.hash.slice(1)}` }, signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  assert.ok(response.body);
  const reader = response.body.getReader();
  try {
    const first = await reader.read();
    assert.equal(JSON.parse(new TextDecoder().decode(first.value)).type, "snapshot");
    bridge.publish({ type: "snapshot", session: fixture() });
    const next = await reader.read();
    assert.equal(JSON.parse(new TextDecoder().decode(next.value)).session.sessionId, "session-a");
    bridge.publish({ type: "stream", message: null });
    const cleared = await reader.read();
    assert.deepEqual(JSON.parse(new TextDecoder().decode(cleared.value)), { type: "stream", message: null });
  } finally {
    await reader.cancel();
    await bridge.close();
  }
});

test("protects model and configuration actions and validates configuration input", async () => {
  const selected: string[] = [];
  const thinking: string[] = [];
  const opened: string[] = [];
  const changes: string[] = [];
  const bridge = await startBridge({
    ...capabilities,
    snapshot: fixture,
    send() {}, abort() {}, async newSession() {},
    async setModel(sessionId, provider, id) { selected.push(`${sessionId}:${provider}/${id}`); },
    async setThinkingLevel(sessionId, level) { thinking.push(`${sessionId}:${level}`); },
    async selectSession(workspaceId, id, path) { opened.push(`${workspaceId}:${id}:${path}`); },
    async updateConfig(change) { changes.push(`${change.scope}:${change.kind}:${change.action}:${change.value}`); return capabilities.config(); },
  }, webRoot);
  try {
    const url = new URL(bridge.url);
    const headers = { Authorization: `Bearer ${url.hash.slice(1)}`, "Content-Type": "application/json", Origin: url.origin };
    assert.equal((await fetch(`${url.origin}/api/models`)).status, 401);
    assert.equal((await fetch(`${url.origin}/api/config`)).status, 401);
    assert.equal((await fetch(`${url.origin}/api/models`, { headers })).status, 200);
    const model = await fetch(`${url.origin}/api/model`, { method: "POST", headers, body: JSON.stringify({ sessionId: "session-a", provider: "example", id: "model" }) });
    assert.equal(model.status, 202);
    assert.deepEqual(selected, ["session-a:example/model"]);
    const effort = await fetch(`${url.origin}/api/thinking-level`, { method: "POST", headers, body: JSON.stringify({ sessionId: "session-a", level: "high" }) });
    assert.equal(effort.status, 202);
    assert.deepEqual(thinking, ["session-a:high"]);
    const missingWorkspace = await fetch(`${url.origin}/api/session/select`, { method: "POST", headers, body: JSON.stringify({ sessionId: "session-a", id: "session-b", path: "/tmp/session-b" }) });
    assert.equal(missingWorkspace.status, 400);
    const openedSession = await fetch(`${url.origin}/api/session/select`, { method: "POST", headers, body: JSON.stringify({ sessionId: "session-a", workspaceId: "workspace-b", id: "session-b", path: "/tmp/session-b" }) });
    assert.equal(openedSession.status, 202);
    assert.deepEqual(opened, ["workspace-b:session-b:/tmp/session-b"]);
    const invalid = await fetch(`${url.origin}/api/config`, { method: "POST", headers, body: JSON.stringify({ sessionId: "session-a", scope: "global", kind: "unknown", action: "add", value: "x" }) });
    assert.equal(invalid.status, 400);
    const packageInExtensions = await fetch(`${url.origin}/api/config`, { method: "POST", headers, body: JSON.stringify({ sessionId: "session-a", scope: "global", kind: "extensions", action: "add", value: "npm:pi-web-access" }) });
    assert.equal(packageInExtensions.status, 400);
    assert.match((await packageInExtensions.json()).error, /包/);
    const valid = await fetch(`${url.origin}/api/config`, { method: "POST", headers, body: JSON.stringify({ sessionId: "session-a", scope: "project", kind: "skills", action: "add", value: "./skills/demo" }) });
    assert.equal(valid.status, 200);
    assert.deepEqual(changes, ["project:skills:add:./skills/demo"]);
  } finally { await bridge.close(); }
});

test("web provider login handles a secret prompt without returning the secret", async () => {
  const bridge = await startBridge({
    ...capabilities, snapshot: fixture, send() {}, abort() {}, async newSession() {},
    providers: async () => [{ id: "example", name: "Example", configured: false, storedCredential: false, methods: ["api_key"] }],
    async loginProvider(_provider, _method, interaction) {
      const key = await interaction.prompt({ type: "secret", message: "API key" });
      assert.equal(key, "test-secret-value");
    },
  }, webRoot);
  try {
    const url = new URL(bridge.url);
    const headers = { Authorization: `Bearer ${url.hash.slice(1)}`, "Content-Type": "application/json", Origin: url.origin };
    assert.equal((await fetch(`${url.origin}/api/providers`)).status, 401);
    const providers = await fetch(`${url.origin}/api/providers`, { headers });
    assert.equal(providers.status, 200);
    const start = await fetch(`${url.origin}/api/provider/login`, { method: "POST", headers, body: JSON.stringify({ sessionId: "session-a", providerId: "example", method: "api_key" }) });
    assert.equal(start.status, 202);
    const { id } = await start.json() as { id: string };
    const statusUrl = `${url.origin}/api/provider/login?id=${id}`;
    const prompt = await fetch(statusUrl, { headers });
    assert.equal((await prompt.json()).prompt.type, "secret");
    const reply = await fetch(`${url.origin}/api/provider/login/respond`, { method: "POST", headers, body: JSON.stringify({ sessionId: "session-a", id, value: "test-secret-value" }) });
    assert.equal(reply.status, 202);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const complete = await fetch(statusUrl, { headers });
    const completeText = await complete.text();
    assert.match(completeText, /"status":"done"/);
    assert.equal(completeText.includes("test-secret-value"), false);
  } finally { await bridge.close(); }
});

test("inline API key connects in one request without exposing the key in login status", async () => {
  const bridge = await startBridge({
    ...capabilities, snapshot: fixture, send() {}, abort() {}, async newSession() {},
    providers: async () => [{ id: "example", name: "Example", configured: false, storedCredential: false, methods: ["api_key"] }],
    async loginProvider(_provider, _method, interaction) {
      assert.equal(await interaction.prompt({ type: "secret", message: "API key" }), "sk-inline-test");
    },
  }, webRoot);
  try {
    const url = new URL(bridge.url);
    const headers = { Authorization: `Bearer ${url.hash.slice(1)}`, "Content-Type": "application/json", Origin: url.origin };
    const start = await fetch(`${url.origin}/api/provider/login`, { method: "POST", headers, body: JSON.stringify({ sessionId: "session-a", providerId: "example", method: "api_key", initialSecret: "sk-inline-test" }) });
    assert.equal(start.status, 202);
    const { id } = await start.json() as { id: string };
    await new Promise((resolve) => setImmediate(resolve));
    const status = await (await fetch(`${url.origin}/api/provider/login?id=${id}`, { headers })).text();
    assert.match(status, /"status":"done"/);
    assert.equal(status.includes("sk-inline-test"), false);
    const invalid = await fetch(`${url.origin}/api/provider/login`, { method: "POST", headers, body: JSON.stringify({ sessionId: "session-a", providerId: "example", method: "oauth", initialSecret: "sk-inline-test" }) });
    assert.equal(invalid.status, 400);
  } finally { await bridge.close(); }
});

test("web provider login relays OAuth device instructions and manual code", async () => {
  const bridge = await startBridge({
    ...capabilities, snapshot: fixture, send() {}, abort() {}, async newSession() {},
    providers: async () => [{ id: "example", name: "Example", configured: false, storedCredential: false, methods: ["oauth"] }],
    async loginProvider(_provider, _method, interaction) {
      interaction.notify({ type: "device_code", verificationUri: "https://example.com/activate", userCode: "ABCD" });
      assert.equal(await interaction.prompt({ type: "manual_code", message: "输入授权码" }), "auth-code");
    },
  }, webRoot);
  try {
    const url = new URL(bridge.url);
    const headers = { Authorization: `Bearer ${url.hash.slice(1)}`, "Content-Type": "application/json", Origin: url.origin };
    const start = await fetch(`${url.origin}/api/provider/login`, { method: "POST", headers, body: JSON.stringify({ sessionId: "session-a", providerId: "example", method: "oauth" }) });
    assert.equal(start.status, 202);
    const { id } = await start.json() as { id: string };
    const statusUrl = `${url.origin}/api/provider/login?id=${id}`;
    const prompt = await (await fetch(statusUrl, { headers })).json();
    assert.equal(prompt.event.type, "device_code");
    assert.equal(prompt.event.userCode, "ABCD");
    assert.equal(prompt.prompt.type, "manual_code");
    assert.equal((await fetch(`${url.origin}/api/provider/login/active`)).status, 401);
    const active = await (await fetch(`${url.origin}/api/provider/login/active`, { headers })).json();
    assert.equal(active.active.id, id);
    assert.equal(active.active.providerId, "example");
    const resumed = await fetch(`${url.origin}/api/provider/login`, { method: "POST", headers, body: JSON.stringify({ sessionId: "session-a", providerId: "example", method: "oauth" }) });
    assert.equal(resumed.status, 202);
    assert.equal((await resumed.json()).id, id);
    const reply = await fetch(`${url.origin}/api/provider/login/respond`, { method: "POST", headers, body: JSON.stringify({ sessionId: "session-a", id, value: "auth-code" }) });
    assert.equal(reply.status, 202);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const complete = await (await fetch(statusUrl, { headers })).text();
    assert.match(complete, /"status":"done"/);
    assert.equal(complete.includes("auth-code"), false);
  } finally { await bridge.close(); }
});

test("only an authenticated active session can add a valid custom provider", async () => {
  const added: string[] = [];
  const bridge = await startBridge({
    ...capabilities, snapshot: fixture, send() {}, abort() {}, async newSession() {},
    async addCustomProvider(_sessionId, provider) { added.push(provider.id); },
  }, webRoot);
  try {
    const url = new URL(bridge.url);
    const endpoint = `${url.origin}/api/provider/custom`;
    const headers = { Authorization: `Bearer ${url.hash.slice(1)}`, "Content-Type": "application/json", Origin: url.origin };
    const provider = { id: "my-api", name: "My API", baseUrl: "https://api.example.com/v1", api: "openai-completions", modelId: "chat" };
    assert.equal((await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: "session-a", provider }) })).status, 401);
    assert.equal((await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ sessionId: "session-b", provider }) })).status, 409);
    assert.equal((await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ sessionId: "session-a", provider: { ...provider, baseUrl: "file:///tmp/api" } }) })).status, 400);
    assert.equal((await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ sessionId: "session-a", provider }) })).status, 201);
    assert.deepEqual(added, ["my-api"]);
  } finally { await bridge.close(); }
});

test("model edits and credential removal require the active authenticated session", async () => {
  const changes: string[] = [];
  const bridge = await startBridge({
    ...capabilities, snapshot: fixture, send() {}, abort() {}, async newSession() {},
    async providerModels(providerId) { return { providerId, models: [{ id: "model", source: "builtin" as const, overridden: false }] }; },
    async updateProviderModel(_sessionId, providerId, change) { changes.push(`${providerId}:${change.action}`); },
    async logoutProvider(_sessionId, providerId) { changes.push(`${providerId}:logout`); },
  }, webRoot);
  try {
    const url = new URL(bridge.url);
    const headers = { Authorization: `Bearer ${url.hash.slice(1)}`, "Content-Type": "application/json", Origin: url.origin };
    const modelUrl = `${url.origin}/api/provider/models`;
    assert.equal((await fetch(`${modelUrl}?providerId=example`)).status, 401);
    assert.equal((await fetch(`${modelUrl}?providerId=example`, { headers })).status, 200);
    const post = (endpoint: string, body: object, authorized = true) => fetch(`${url.origin}${endpoint}`, { method: "POST", headers: authorized ? headers : { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const save = { sessionId: "session-a", providerId: "example", change: { action: "save", model: { id: "new", contextWindow: 128000 } } };
    assert.equal((await post("/api/provider/models", save, false)).status, 401);
    assert.equal((await post("/api/provider/models", { ...save, sessionId: "stale" })).status, 409);
    assert.equal((await post("/api/provider/models", { ...save, change: { action: "save", model: { id: "bad", maxTokens: -1 } } })).status, 400);
    assert.equal((await post("/api/provider/models", save)).status, 200);
    assert.equal((await post("/api/provider/logout", { sessionId: "session-a", providerId: "example" })).status, 200);
    assert.deepEqual(changes, ["example:save", "example:logout"]);
  } finally { await bridge.close(); }
});

test("browses folders and creates a child through the authenticated directory API", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-picker-"));
  const bridge = await startBridge({ ...capabilities, snapshot: fixture, send() {}, abort() {}, async newSession() {} }, webRoot);
  try {
    const url = new URL(bridge.url);
    const headers = { Authorization: `Bearer ${url.hash.slice(1)}`, "Content-Type": "application/json", Origin: url.origin };
    const post = (endpoint: string, data: object) => fetch(`${url.origin}${endpoint}`, { method: "POST", headers, body: JSON.stringify({ sessionId: "session-a", ...data }) });
    const created = await post("/api/directory/create", { path: root, name: "project" });
    assert.equal(created.status, 200);
    assert.equal((await created.json()).path, join(root, "project"));
    const listed = await post("/api/directory/list", { path: root });
    assert.equal(listed.status, 200);
    const listing = await listed.json();
    assert.deepEqual(listing.entries.map((entry: { name: string }) => entry.name), ["project"]);
    assert.equal(listing.crumbs.at(-1).path, root);
    assert.equal((await post("/api/directory/create", { path: root, name: "../outside" })).status, 400);
    assert.equal((await post("/api/directory/list", { path: "." })).status, 400);
    const unauthorized = await fetch(`${url.origin}/api/directory/list`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: "session-a", path: root }) });
    assert.equal(unauthorized.status, 401);
    const capability = await fetch(`${url.origin}/api/directory/capability`, { headers });
    assert.equal(capability.status, 200);
    assert.ok(["native", "browse"].includes((await capability.json()).kind));
  } finally {
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  }
});
