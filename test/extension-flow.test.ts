import { createEventBus } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import piWeb from "../extension/index.ts";

test("web keeps a fresh Pi sender after creating a session", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "pi-web-flow-"));
  const canonicalTemporary = await realpath(temporary);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(temporary, "agent");
  const handlers = new Map<string, (event: any, ctx: any) => void>();
  const delivered: string[] = [];
  const openedPages: string[] = [];
  const notices: Array<"info" | "warning" | "error" | undefined> = [];
  let failToOpen = false;
  let command: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
  let pageUrl = "";
  let oldRuntimeStale = false;
  const context = (id: string) => ({
    cwd: temporary,
    model: undefined,
    thinkingLevel: "medium",
    sessionManager: {
      getSessionId: () => id,
      getSessionName: () => undefined,
      getBranch: () => [],
    },
    isIdle: () => true,
    getContextUsage: () => undefined,
    ui: {
      notify(message: string, type?: "info" | "warning" | "error") {
        pageUrl = message.slice("pi-webapp: ".length);
        notices.push(type);
      },
      setStatus() {},
    },
  });
  const fresh = {
    ...context("new"),
    async sendUserMessage(text: string) { delivered.push(text); },
  } as unknown as ExtensionCommandContext;
  const initial = {
    ...context("old"),
    async newSession(options?: { withSession?: (ctx: ExtensionCommandContext) => Promise<void> }) {
      oldRuntimeStale = true;
      handlers.get("session_shutdown")?.({ reason: "new" }, initial);
      await options?.withSession?.(fresh);
      handlers.get("session_start")?.({ type: "session_start" }, fresh);
      return { cancelled: false };
    },
  } as unknown as ExtensionCommandContext;
  piWeb({
    events: createEventBus(),
    on(event: string, handler: (event: unknown, ctx: unknown) => void) { handlers.set(event, handler); return () => {}; },
    registerCommand(name: string, definition: { handler: typeof command }) { if (name === "web") command = definition.handler; },
    getSessionName() { if (oldRuntimeStale) throw new Error("stale Pi API"); return undefined; },
    sendUserMessage() { if (oldRuntimeStale) throw new Error("stale Pi API"); },
  } as unknown as ExtensionAPI, async (url) => {
    openedPages.push(url);
    if (failToOpen) throw new Error("no browser available");
    return true;
  });
  assert.ok(command);
  await command("", initial);
  const url = new URL(pageUrl);
  assert.deepEqual(openedPages, [pageUrl]);
  await command("", initial);
  assert.deepEqual(openedPages, [pageUrl, pageUrl]);
  failToOpen = true;
  await command("", initial);
  assert.deepEqual(openedPages, [pageUrl, pageUrl, pageUrl]);
  assert.deepEqual(notices, ["info", "info", "warning"]);
  const headers = { Authorization: `Bearer ${url.hash.slice(1)}`, "Content-Type": "application/json", Origin: url.origin };
  const shared = (globalThis as Record<symbol, { bridge: { close(): Promise<void> } | null }>)[Symbol.for(`pi-web.bridge-state:${new URL("../extension/index.ts", import.meta.url).href}`)];
  try {
    const created = await fetch(`${url.origin}/api/new-session`, {
      method: "POST", headers, body: JSON.stringify({ sessionId: "old" }),
    });
    assert.equal(created.status, 202);
    const snapshot = await fetch(`${url.origin}/api/session`, { headers });
    assert.equal((await snapshot.json()).sessionId, "new");
    const sent = await fetch(`${url.origin}/api/message`, {
      method: "POST", headers, body: JSON.stringify({ sessionId: "new", text: "hello" }),
    });
    assert.equal(sent.status, 202);
    assert.deepEqual(delivered, ["hello"]);
    const nextDirectory = join(temporary, "another-project");
    const added = await fetch(`${url.origin}/api/workspace/add`, {
      method: "POST", headers, body: JSON.stringify({ sessionId: "new", path: nextDirectory, create: true }),
    });
    assert.equal(added.status, 202, await added.text());
    const changed = await fetch(`${url.origin}/api/session`, { headers });
    assert.equal((await changed.json()).cwd, await realpath(nextDirectory));
    const workspaces = await fetch(`${url.origin}/api/workspaces`, { headers });
    const listed = await workspaces.json();
    assert.equal(listed.items.length, 2);
    const initialWorkspace = listed.items.find((item: { path: string }) => item.path === canonicalTemporary);
    const selected = await fetch(`${url.origin}/api/workspace/select`, {
      method: "POST", headers, body: JSON.stringify({ sessionId: (await (await fetch(`${url.origin}/api/session`, { headers })).json()).sessionId, id: initialWorkspace.id }),
    });
    assert.equal(selected.status, 202, await selected.text());
    const back = await fetch(`${url.origin}/api/session`, { headers });
    assert.equal((await back.json()).cwd, temporary);
    const otherDirectory = await realpath(nextDirectory);
    const other = SessionManager.create(otherDirectory);
    other.appendMessage({ role: "user", content: "other workspace", timestamp: Date.now() });
    other.appendMessage({ role: "assistant", content: [{ type: "text", text: "ready" }], timestamp: Date.now(), provider: "test", model: "model", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } } } as Parameters<SessionManager["appendMessage"]>[0]);
    const all = await (await fetch(`${url.origin}/api/workspaces`, { headers })).json();
    const otherWorkspace = all.items.find((item: { path: string }) => item.path === otherDirectory);
    const otherSession = all.sessions.find((item: { id: string }) => item.id === other.getSessionId());
    assert.equal(otherSession.workspaceId, otherWorkspace.id);
    const switched = await fetch(`${url.origin}/api/session/select`, {
      method: "POST", headers,
      body: JSON.stringify({ sessionId: "new", workspaceId: otherWorkspace.id, id: otherSession.id, path: otherSession.path }),
    });
    assert.equal(switched.status, 202, await switched.text());
    assert.equal((await (await fetch(`${url.origin}/api/session`, { headers })).json()).sessionId, other.getSessionId());
  } finally {
    await shared.bridge?.close();
    shared.bridge = null;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(temporary, { recursive: true, force: true });
  }
});
