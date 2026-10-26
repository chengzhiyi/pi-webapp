import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { boxes, hostedParity, pluginId } from "../helpers/hosted-parity.ts";
import { schemaRelease } from "../helpers/hosted-schema-release.ts";

function latch() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

test("ORI-39 A05/A21: real SDK long stream and pending batch drain on old schema/worker while same-profile windows update", async ({ page, context }, info) => {
  test.skip(!process.env.HOSTED_EXCALIDRAW_TGZ, "Explicit archive required"); test.setTimeout(120_000);
  const h = await hostedParity(page);
  const releaseTool = latch(), toolEntered = latch();
  let heldStream: ReturnType<typeof createAssistantMessageEventStream> | undefined;
  let running: Promise<void> | undefined, queued: Promise<void> | undefined;
  try {
    const created = await h.tool("excalidraw_create_view", boxes());
    // Create the retained background session before mounting browser realms; switching a
    // mounted session is a separate view-close lifecycle, not part of this stream gate.
    await h.sessions.open(h.root, "new"); const second = h.sessions.session!;
    await h.sessions.open(h.root, { sessionId: h.sessionId });
    await page.goto(h.bridge.url); await h.open();
    const peer = await context.newPage(); await peer.goto(h.bridge.url); await h.open(peer);
    const boot = await page.evaluate(() => ((window as any).__ori39Boot = crypto.randomUUID()));
    const peerBoot = await peer.evaluate(() => ((window as any).__ori39Boot = crypto.randomUUID()));
    const model = h.retained.model!;
    await second.modelRuntime.setRuntimeApiKey("openai", "fixture-no-network"); await second.setModel(model);
    const supervisor = (h.integration.manager as any).supervisors.get(pluginId);
    const oldPid = supervisor.pid, generation = (await h.card()).generation!;
    const secondDraft = await h.integration.handlers.action({ pluginId, generation, sessionId: second.sessionManager.getSessionId(), action: "new", input: {} }) as any;
    let shutdowns = 0, reloads = 0;
    for (const session of [h.retained, second]) {
      const dispose = session.dispose.bind(session), reload = session.reload.bind(session);
      session.dispose = (...args) => { shutdowns++; return dispose(...args); };
      session.reload = (...args) => { reloads++; return reload(...args); };
    }
    const originalInvoke = h.integration.manager.invoke.bind(h.integration.manager);
    const requests: any[] = [];
    h.integration.manager.invoke = async (id, gen, request, ...rest) => {
      if (request.kind === "tool") {
        requests.push({ generation: gen, action: request.action, input: request.input, pid: supervisor.pid });
        if (request.action === "read" && (request.input as any).id === created.id && requests.length === 1) { toolEntered.resolve(); await releaseTool.promise; }
      }
      return originalInvoke(id, gen, request, ...rest);
    };
    const oldSchemas: any[] = [], newSchemas: any[] = [];
    let stage = 0, newStage = 0;
    const streamStarted = latch();
    h.retained.agent.streamFunction = async (model, ctx) => {
      oldSchemas.push(ctx.messages.filter(m => m.role === "system").flatMap(m => m.toolsAdded ?? []).filter(t => t.name === "diagram_read").at(-1)?.parameters);
      const first = stage++ === 0;
      const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), usage, content: [{ type: "text", text: first ? "" : "Old batch done" }], stopReason: first ? "toolUse" : "stop" };
      const stream = createAssistantMessageEventStream(); stream.push({ type: "start", partial: message });
      if (first) { heldStream = stream; stream.push({ type: "text_start", contentIndex: 0, partial: message }); (stream as any).__partial = message; streamStarted.resolve(); }
      else { stream.push({ type: "done", reason: "stop", message }); stream.end(message); }
      return stream;
    };
    second.agent.streamFunction = async (model, ctx) => {
      newSchemas.push(ctx.messages.filter(m => m.role === "system").flatMap(m => m.toolsAdded ?? []).filter(t => t.name === "diagram_read").at(-1)?.parameters);
      const first = newStage++ === 0;
      const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), usage, content: first ? [{ type: "toolCall", id: "new-schema", name: "diagram_read", arguments: { id: secondDraft.id, ori39Schema: 2 } }] : [{ type: "text", text: "New schema done" }], stopReason: first ? "toolUse" : "stop" };
      const stream = createAssistantMessageEventStream(); stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: first ? "toolUse" : "stop", message }); stream.end(message); return stream;
    };
    const streamStart = Date.now();
    running = h.retained.prompt("Deterministic local long-stream transport, not a remote provider"); await streamStarted.promise;
    const partial = (heldStream as any).__partial as AssistantMessage;
    for (let i = 0; i < 64; i++) {
      const delta = `Local streamed chunk ${i}. `; (partial.content[0] as any).text += delta;
      heldStream!.push({ type: "text_delta", contentIndex: 0, delta, partial });
    }
    await expect(page.getByText(/Local streamed chunk 63\./).first()).toBeVisible();
    const archive = await schemaRelease(h.root, process.env.HOSTED_EXCALIDRAW_TGZ!);
    const syntheticPath = info.outputPath("ori39-SYNTHETIC-schema-2.tgz");
    await writeFile(syntheticPath, archive); await info.attach("synthetic-schema-release", { path: syntheticPath, contentType: "application/gzip" });
    h.upgradeArchive(archive);
    const updateIn = (target: typeof page) => target.evaluate(async ({ token, pluginId }) => {
      const response = await fetch("/api/hosted-plugins/manage", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ pluginId, operation: "update", reopenEditors: true }) });
      return { status: response.status, body: await response.json() };
    }, { token: new URL(h.bridge.url).hash.slice(1), pluginId });
    const diagnose = async (result: Awaited<ReturnType<typeof updateIn>>) => { if (result.status !== 200) console.error("UPDATE FAILURE:", JSON.stringify(result)); return result; };
    const updating = updateIn(page).then(diagnose), competing = updateIn(peer).then(diagnose);
    await expect.poll(() => h.integration.adapter.isFrozen).toBe(true);
    expect(supervisor.pid).toBe(oldPid); expect((await h.card()).generation).toBe(generation);
    queued = second.prompt("New SDK admission must wait for the actual settled batch");
    await expect.poll(() => newStage).toBe(0);
    await h.sessions.send("Host request during freeze").then(() => { throw new Error("freeze must reject host send"); }, error => expect(String(error)).toMatch(/Pi 正在运行，请选择引导或排队/));
    // Continue producing real SDK deltas while the candidate is staged and admission is
    // frozen. This paced fixture is a provider transport, not an external-model claim.
    for (let i = 64; i < 128; i++) {
      const delta = `Local streamed chunk ${i}. ` + "stream-content ".repeat(32);
      (partial.content[0] as any).text += delta;
      heldStream!.push({ type: "text_delta", contentIndex: 0, delta, partial });
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(newStage).toBe(0); expect(supervisor.pid).toBe(oldPid);
    // The provider can finish after the update request. Its pending tools must still use
    // the old real worker/lease, not the newly staged schema.
    partial.content.push({ type: "toolCall", id: "old-a", name: "diagram_read", arguments: { id: created.id } }, { type: "toolCall", id: "old-b", name: "diagram_read", arguments: { id: created.id } });
    heldStream!.push({ type: "done", reason: "toolUse", message: partial }); heldStream!.end(partial); heldStream = undefined;
    await toolEntered.promise;
    expect(supervisor.pid).toBe(oldPid); expect((await h.card()).generation).toBe(generation); expect(newStage).toBe(0);
    releaseTool.resolve(); await running;
    const updates = await Promise.all([updating, competing]); expect(updates.map(r => r.status)).toEqual([200, 200]);
    await queued;
    expect(requests.filter(r => r.generation === generation)).toHaveLength(2);
    expect(requests.slice(0, 2).every(r => r.pid === oldPid && r.input.ori39Schema === undefined)).toBe(true);
    expect(oldSchemas[0].required).not.toContain("ori39Schema");
    expect(newSchemas[0].required).toContain("ori39Schema");
    expect(requests.at(-1).generation).toBeGreaterThan(generation); expect(requests.at(-1).input.ori39Schema).toBe(2);
    expect(supervisor.pid).not.toBe(oldPid); expect(shutdowns).toBe(0); expect(reloads).toBe(0);
    expect(second.messages.find(m => m.role === "toolResult" && m.toolCallId === "new-schema")).toMatchObject({ role: "toolResult", isError: false });
    for (const call of ["old-a", "old-b"]) expect(h.retained.messages.find(m => m.role === "toolResult" && m.toolCallId === call)).toMatchObject({ role: "toolResult", isError: false });
    expect(h.sessions.session).toBe(h.retained); expect(await page.evaluate(() => (window as any).__ori39Boot)).toBe(boot); expect(await peer.evaluate(() => (window as any).__ori39Boot)).toBe(peerBoot);
    expect(h.errors).toEqual([]); expect(h.external).toEqual([]);
    await info.attach("stream-and-schema-evidence", { body: JSON.stringify({ syntheticArchiveSha256: createHash("sha256").update(archive).digest("hex"), requests, oldSchemas, newSchemas, updates, chunks: 128, streamedCharacters: (partial.content[0] as any).text.length, streamAndDrainMs: Date.now() - streamStart, shutdowns, reloads, oldPid, newPid: supervisor.pid }), contentType: "application/json" });
  } catch (error) {
    await info.attach("primary-failure", { body: error instanceof Error ? error.stack ?? error.message : String(error), contentType: "text/plain" });
    console.error("PRIMARY:", error);
    throw error;
  } finally {
    releaseTool.resolve();
    if (heldStream) {
      const message = (heldStream as any).__partial as AssistantMessage; message.stopReason = "stop";
      heldStream.push({ type: "done", reason: "stop", message }); heldStream.end(message);
      await h.retained.abort();
    }
    await running?.catch(() => {}); await queued?.catch(() => {});
    await h.close();
  }
});
