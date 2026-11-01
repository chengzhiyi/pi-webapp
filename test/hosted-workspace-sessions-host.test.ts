import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { WorkspaceSessions } from "../src/host/server/sessions/workspace-sessions.ts";
import { workspaceSessionsHost } from "../src/host/server/plugins/hosted/capabilities/workspace-sessions-host.ts";
import { controlledReply } from "./helpers/controlled-reply.ts";

test("plugin sessions are detached, read-only until authorized, owned, event-fed and releasable", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-detached-"));
  const saved = { agent: process.env.PI_CODING_AGENT_DIR, plugins: process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS };
  process.env.PI_CODING_AGENT_DIR = join(root, "agent"); process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS = "";
  const cwd = join(root, "work"); await mkdir(cwd);
  const events: unknown[] = [];
  const ws = new WorkspaceSessions(e => events.push(e), () => undefined);
  let allow = false;
  const host = workspaceSessionsHost(ws, async () => allow);
  try {
    await ws.open(cwd, "new");
    const foreground = ws.session!;
    const { sessionId } = await (async () => {
      // Stub the model for the plugin session before its first prompt: it is created inside create(), so patch via the first stream.
      const pending = host.create({ pluginId: "p", cwd, title: "owner/repo#7", prompt: "plan it", mode: "plan" });
      return pending;
    })().catch(() => ({ sessionId: "" }));
    // Without a configured model the first prompt is rejected: the session must not leak.
    assert.equal(sessionId, "");
    assert.equal(host.activeCount("p"), 0);
    assert.equal(ws.session, foreground, "failed creation never changes the foreground session");

    // Create without the host prompt step to attach a controlled model, then drive the same adapter path.
    const id = await ws.createDetached(cwd, "p", "owner/repo#7");
    const session = (ws as unknown as { runtimes: Map<string, { session: AgentSession }> }).runtimes.get(id)!.session;
    assert.equal(ws.session, foreground, "creation does not steal the foreground");
    assert.deepEqual(session.getActiveToolNames().sort(), ["find", "grep", "ls", "read"]);
    assert.equal(host.ownerOf(id), "p"); assert.equal(host.activeCount("p"), 1); assert.equal(host.ownerOf(foreground.sessionManager.getSessionId()), null);

    const reply = await controlledReply(session, "THE PLAN");
    await host.send(id, "plan it"); await reply.ready; reply.finish(); await session.waitForIdle();
    const got = await host.events(id, 0);
    assert.deepEqual(got.events.map(e => [e.type, e.text]), [["turn_end", "THE PLAN"]]);
    assert.deepEqual((await host.events(id, got.next)).events, []);

    await assert.rejects(host.send(id, "go", "execute"), { code: "execute_denied" });
    assert.deepEqual(session.getActiveToolNames().sort(), ["find", "grep", "ls", "read"], "denied execute leaves the restriction in place");
    allow = true;
    const second = await controlledReply(session, "DONE");
    await host.send(id, "go", "execute"); await second.ready; second.finish(); await session.waitForIdle();
    assert.deepEqual(session.getActiveToolNames().sort(), foreground.getActiveToolNames().sort(), "authorized execute restores the original tools");
    assert.ok(session.getActiveToolNames().includes("bash"));

    await host.release(id);
    assert.equal(host.ownerOf(id), null); assert.equal(host.activeCount("p"), 0);
    assert.equal(ws.session, foreground);
  } finally {
    await ws.dispose();
    for (const [k, v] of [["PI_CODING_AGENT_DIR", saved.agent], ["PI_WEBAPP_PLUGIN_DEV_ROOTS", saved.plugins]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await rm(root, { recursive: true, force: true });
  }
});
