import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkspaceSessions } from "../extension/workspace-sessions.ts";
import type { BridgeEvent } from "../extension/bridge.ts";
import { controlledReply } from "./helpers/controlled-reply.ts";


test("SDK sessions run independently across workspace and session switches", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-background-"));
  const savedAgent = process.env.PI_CODING_AGENT_DIR;
  const savedPlugins = process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS = "";
  const first = join(root, "first"); const second = join(root, "second");
  await mkdir(first); await mkdir(second);
  const events: BridgeEvent[] = [];
  const host = new WorkspaceSessions(event => events.push(event), () => undefined);
  try {
    await host.open(first, "new");
    const a = host.session!;
    const aReply = await controlledReply(a, "First workspace progress");
    await host.send("Work in A"); await aReply.ready;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(a.isIdle, false);

    await host.open(second, "new");
    const b = host.session!;
    assert.notEqual(a, b);
    assert.equal(a.isIdle, false, "switching must leave the original task running");
    const bReply = await controlledReply(b, "Second workspace progress");
    await host.send("Work in B"); await bReply.ready;
    assert.equal(b.isIdle, false);
    await host.open(first, "continue");
    assert.equal(host.session, a, "returning reuses the running instance");
    assert.equal(host.snapshot().idle, false);
    assert.ok(JSON.stringify(events.at(-1)).includes("First workspace progress"), "returning restores partial output");

    await host.open(first, "new");
    const c = host.session!;
    assert.notEqual(c, a);
    assert.equal(a.isIdle, false, "new chats in the same workspace also run independently");
    const emptyId = host.snapshot().sessionId;
    await host.open(first, { sessionId: a.sessionManager.getSessionId() });
    assert.equal(host.session, a);
    await host.open(first, { sessionId: emptyId });
    assert.equal(host.session, c, "empty chats are reusable before they have a saved file");
    await assert.rejects(host.open(second, { sessionId: emptyId }), /不属于该工作区/);
    await host.open(second, "continue");
    assert.equal(host.session, b);
    await host.stop();
    assert.equal(b.isIdle, true);
    assert.equal(a.isIdle, false, "stop affects only the selected chat");

    events.length = 0;
    aReply.finish(); await a.waitForIdle();
    assert.equal(host.session, b);
    assert.ok(events.every(event => event.type !== "stream" && event.type !== "snapshot" && event.type !== "error"), "background output cannot overwrite the selected chat");
    await host.open(first, { sessionFile: a.sessionManager.getSessionFile()! });
    assert.equal(host.session, a);
    assert.equal(host.snapshot().idle, true);
    assert.ok(host.snapshot().messages.some(message => message.blocks.some(block => block.text === "First workspace progress")));
  } finally {
    await host.dispose();
    if (savedAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedAgent;
    if (savedPlugins === undefined) delete process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS; else process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS = savedPlugins;
    await rm(root, { recursive: true, force: true });
  }
});

test("background failures stay in their chat and service shutdown cancels all active runs", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-background-failure-"));
  const savedAgent = process.env.PI_CODING_AGENT_DIR;
  const savedPlugins = process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS = "";
  const first = join(root, "first"); const second = join(root, "second");
  await mkdir(first); await mkdir(second);
  const events: BridgeEvent[] = [];
  const failures: unknown[] = [];
  const host = new WorkspaceSessions(event => events.push(event), () => undefined, () => false, cause => { failures.push(cause); return "fixture-error"; });
  try {
    await host.open(first, "new");
    const a = host.session!;
    const aReply = await controlledReply(a, "Failed background progress");
    await host.send("Work in A"); await aReply.ready;
    await assert.rejects(host.reload(), /请等待当前回复结束/, "reloading the selected runtime still requires idle");
    await host.open(second, "new");
    const b = host.session!;
    const bReply = await controlledReply(b, "Pending background progress");
    await host.send("Work in B"); await bReply.ready;
    await new Promise(resolve => setImmediate(resolve));
    events.length = 0;
    aReply.fail(); await a.waitForIdle();
    assert.equal(failures.length, 1, "background failures remain observable");
    assert.equal(events.length, 0, "background errors cannot appear in the foreground chat");
    await host.open(first, "continue");
    assert.ok(host.snapshot().messages.some(message => message.role === "assistant" && message.error === "Fixture response failed"));
    const nextReply = await controlledReply(a, "Pending foreground progress");
    await host.send("Try again"); await nextReply.ready;
    events.length = 0;
    await host.dispose(); await host.dispose();
    assert.equal(nextReply.wasAborted(), true);
    assert.equal(bReply.wasAborted(), true, "shutdown also aborts hidden tasks");
    assert.equal(events.length, 0, "closed runtimes cannot publish late events");
    assert.deepEqual(host.retainedSessions(), []);
    await assert.rejects(host.open(first, "continue"), /工作区服务已关闭/);
  } finally {
    await host.dispose();
    if (savedAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedAgent;
    if (savedPlugins === undefined) delete process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS; else process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS = savedPlugins;
    await rm(root, { recursive: true, force: true });
  }
});
