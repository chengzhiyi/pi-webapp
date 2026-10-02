import { createEventBus } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piWeb from "../extension/index.ts";

test("launcher mode opens the web bridge on Pi session start only once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-auto-open-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousAutoOpen = process.env.PI_WEBAPP_AUTO_OPEN;
  process.env.PI_CODING_AGENT_DIR = join(directory, "agent");
  process.env.PI_WEBAPP_AUTO_OPEN = "1";
  const previousWorkspace = join(directory, "previous-project");
  await mkdir(previousWorkspace);
  const previousSession = SessionManager.create(previousWorkspace);
  previousSession.appendMessage({ role: "user", content: "Earlier conversation", timestamp: Date.now() });
  previousSession.appendMessage({ role: "assistant", content: [{ type: "text", text: "Earlier reply" }], timestamp: Date.now() } as Parameters<SessionManager["appendMessage"]>[0]);
  const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
  let openCount = 0;
  let resolveOpened!: (url: string) => void;
  const opened = new Promise<string>((resolve) => { resolveOpened = resolve; });
  piWeb({
    events: createEventBus(),
    on(event: string, handler: (event: unknown, ctx: unknown) => void) { handlers.set(event, handler); return () => {}; },
    registerCommand() {},
  } as unknown as ExtensionAPI, async (url) => {
    openCount++;
    resolveOpened(url);
    return true;
  });
  const context = {
    cwd: directory,
    mode: "tui",
    model: undefined,
    thinkingLevel: "medium",
    sessionManager: {
      getSessionId: () => "startup",
      getSessionName: () => undefined,
      getBranch: () => [],
    },
    isIdle: () => true,
    getContextUsage: () => undefined,
    ui: { notify() {}, setStatus() {} },
  };
  const legacyKey = Symbol.for("pi-web.bridge-state");
  const globals = globalThis as Record<symbol, unknown>;
  const previousLegacy = globals[legacyKey];
  const legacyState = { bridge: { close() { throw new Error("Legacy bridge closed"); } } };
  globals[legacyKey] = legacyState;
  const shared = (globalThis as Record<symbol, { bridge: { close(): Promise<void> } | null; autoOpened: boolean }>)[Symbol.for(`pi-web.bridge-state:${new URL("../extension/index.ts", import.meta.url).href}`)];
  try {
    handlers.get("session_start")?.({}, context);
    handlers.get("session_start")?.({}, context);
    const url = new URL(await opened);
    const headers = { Authorization: `Bearer ${url.hash.slice(1)}` };
    const response = await fetch(`${url.origin}/api/session`, { headers });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).sessionId, "startup");
    assert.equal(openCount, 1);
    handlers.get("session_shutdown")?.({ reason: "reload" }, context);
    await handlers.get("session_start")?.({ reason: "reload" }, context);
    assert.equal((await fetch(`${url.origin}/api/session`, { headers })).status, 200);
    assert.equal(globals[legacyKey], legacyState);
    const workspaces = await (await fetch(`${url.origin}/api/workspaces`, { headers })).json();
    const canonicalPreviousWorkspace = await realpath(previousWorkspace);
    const restored = workspaces.items.find((item: { path: string }) => item.path === canonicalPreviousWorkspace);
    assert.ok(restored, "saved Pi workspace should appear in the sidebar");
    assert.ok(workspaces.sessions.some((item: { id: string; workspaceId: string }) => item.id === previousSession.getSessionId() && item.workspaceId === restored.id));
    const next = await fetch(`${url.origin}/api/new-session`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json", Origin: url.origin },
      body: JSON.stringify({ sessionId: "startup" }),
    });
    assert.equal(next.status, 202, await next.text());
    const current = await (await fetch(`${url.origin}/api/session`, { headers })).json();
    assert.notEqual(current.sessionId, "startup");
  } finally {
    if (previousLegacy === undefined) delete globals[legacyKey]; else globals[legacyKey] = previousLegacy;
    await shared.bridge?.close();
    shared.bridge = null;
    shared.autoOpened = false;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousAutoOpen === undefined) delete process.env.PI_WEBAPP_AUTO_OPEN;
    else process.env.PI_WEBAPP_AUTO_OPEN = previousAutoOpen;
    await rm(directory, { recursive: true, force: true });
  }
});
