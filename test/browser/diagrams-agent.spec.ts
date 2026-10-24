import { test, expect } from "@playwright/test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { WorkspaceSessions } from "../../src/host/server/sessions/workspace-sessions.ts";
import { startBridge, type Bridge, type BridgeHost } from "../../src/host/server/transport/bridge.ts";
import { diagramTools } from "../../src/plugins/builtin/diagrams/server/tools.ts";
import { diagramReference } from "../../src/plugins/builtin/diagrams/contract/reference.ts";
import { DIAGRAM_PLUGIN, type DiagramDraft } from "../../src/plugins/builtin/diagrams/contract/diagrams.ts";
import { nativeMenu } from "../helpers/diagram-browser.ts";
import { terminalHost } from "../helpers/terminal-host.ts";

test.use({ video: "on", viewport: { width: 1440, height: 1000 } });
test("main chat drives SDK tools and the native editor; next prompt waits for manual state to reach the agent", async ({ page }, info) => {
  test.setTimeout(60_000);
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "pi-diagram-agent-")));
  const prior = process.env.PI_CODING_AGENT_DIR, priorRoots = process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS;
  process.env.PI_CODING_AGENT_DIR = join(cwd, "agent"); process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS = "";
  let bridge: Bridge | undefined, lastRead: { id: string; revision: number; elements: { id: string; x: number }[] } | undefined;
  const tools = diagramTools(async (...args) => { const result = await bridge!.runPluginTool(...args); if (args[3] === "read") lastRead = result as typeof lastRead; return result; });
  const sessions = new WorkspaceSessions(event => bridge?.publish(event), () => undefined, () => false, () => undefined, undefined, () => {}, tools);
  let release: (() => void) | undefined;
  try {
    await sessions.open(cwd, "new"); const session = sessions.session!;
    const model = session.modelRuntime.getModels("openai")[0]!;
    await session.modelRuntime.setRuntimeApiKey("openai", "fixture-no-network"); await session.setModel(model);
    let calls = 0, sent = 0;
    session.agent.streamFunction = async model => {
      const stage = ++calls;
      const content: AssistantMessage["content"] = stage === 1 ? [{ type: "toolCall", id: "format", name: "excalidraw_read_me", arguments: {} }]
        : stage === 2 ? [{ type: "toolCall", id: "draw", name: "excalidraw_create_view", arguments: diagramReference.elementsExample }]
        : stage === 4 ? [{ type: "toolCall", id: "read", name: "diagram_read", arguments: {} }]
        : stage === 5 ? [{ type: "toolCall", id: "patch", name: "diagram_patch", arguments: { id: lastRead!.id, baseRevision: lastRead!.revision, patch: { addNodes: [{ id: "success", label: "登录成功", x: 740, y: 80 }], addEdges: [{ id: "pass", from: "check", to: "success", label: "通过" }] } } }]
        : [{ type: "text", text: stage === 3 ? "登录流程已绘制，可点击编辑手动调整。" : "已按最新手改图稿补充成功节点，请在对话中应用修改。" }];
      const reason = content[0]!.type === "toolCall" ? "toolUse" : "stop";
      const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content, stopReason: reason, timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream(); stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason, message }); stream.end(message); return stream;
    };
    const template = terminalHost(cwd).host;
    const host: BridgeHost = { ...template, snapshot: () => sessions.snapshot(), models: () => [{ provider: model.provider, id: model.id, name: model.name }],
      send: (_id, text, images, correlation, delivery) => { sent++; return sessions.send(text, images, correlation, delivery); }, abort: () => sessions.stop() };
    bridge = await startBridge(host, new URL("../../web/dist/", import.meta.url).pathname);
    await page.addInitScript(() => { localStorage.setItem("pi-web-locale", "en"); Reflect.deleteProperty(window, "showSaveFilePicker"); Reflect.deleteProperty(window, "showOpenFilePicker"); }); await page.goto(bridge.url);
    const composer = page.getByRole("textbox", { name: "Send a message to the current Pi session", exact: true });
    await composer.fill("请画一个中文验证码登录流程"); await composer.press("Enter");
    const artifact = page.getByRole("article", { name: "Diagram: 登录流程", exact: true });
    await expect(artifact.getByRole("img")).toBeVisible(); await expect.poll(() => calls).toBe(3);
    const sessionId = sessions.snapshot().sessionId, base = new URL(bridge.url);
    const get = async (): Promise<DiagramDraft> => fetch(base.origin + "/api/diagrams/get", { method: "POST", headers: { Authorization: `Bearer ${base.hash.slice(1)}`, "Content-Type": "application/json" }, body: JSON.stringify({ sessionId, id: (await bridge!.runPluginTool(DIAGRAM_PLUGIN, cwd, sessionId, "read", {}) as { id: string }).id }) }).then(r => r.json());
    await expect.poll(async () => (await get()).candidate).toBe(null);
    const before = await get(); lastRead = undefined;
    await artifact.getByRole("button", { name: "Edit Excalidraw", exact: true }).click();
    const panel = page.locator("[data-sidebar-right-session]"); await expect(panel.locator(".excalidraw canvas.interactive")).toBeVisible();
    await expect(panel.getByRole("textbox")).toHaveCount(0);
    let blocked = false; const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/api/diagrams/sync", async route => { blocked = true; await gate; await route.continue(); });
    await panel.locator(".excalidraw canvas.interactive").click(); await page.keyboard.press("ControlOrMeta+a"); await page.keyboard.press("ArrowRight"); await page.keyboard.press("Escape");
    await expect.poll(() => blocked).toBe(true);
    await composer.fill("增加登录成功节点，保留我手动调整的位置"); await composer.press("Enter");
    // Pre-send hook must still be waiting on the hand-edit sync request.
    await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
    expect(sent).toBe(1); expect(calls).toBe(3);
    release!();
    await expect.poll(() => calls).toBe(6);
    const read = lastRead!; expect(read).toBeTruthy(); expect(read.elements.find(e => e.id === "input")!.x).not.toBe(before.scene.elements.find(e => e.id === "input")!.x);
    const latest = page.getByRole("article", { name: "Diagram: 登录流程", exact: true }).last();
    await expect(latest.getByRole("button", { name: "Apply edits", exact: true })).toBeEnabled();
    await latest.getByRole("button", { name: "Apply edits", exact: true }).click();
    await expect.poll(async () => (await get()).scene.elements.some(e => e.id === "success")).toBe(true);
    expect((await get()).scene.elements.find(e => e.id === "input")!.x).toBe(read.elements.find(e => e.id === "input")!.x);
    await page.screenshot({ path: info.outputPath("main-chat-agent-and-native-editor.png") });
    // A failed pre-send synchronization must be visible and must not dispatch a stale prompt.
    await page.unroute("**/api/diagrams/sync");
    await page.route("**/api/diagrams/sync", route => route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "Fixture manual sync conflict", errorCode: "validation_error" }) }));
    await panel.locator(".excalidraw canvas.interactive").click(); await page.keyboard.press("ControlOrMeta+a"); await page.keyboard.press("ArrowRight"); await page.keyboard.press("Escape");
    await composer.fill("继续改图但不能丢失手改"); await composer.press("Enter");
    await expect(page.locator(".pi-error")).toContainText("Fixture manual sync conflict");
    await expect(composer).toHaveText("继续改图但不能丢失手改"); expect(sent).toBe(2); expect(calls).toBe(6);
    const rescue = page.waitForEvent("download"); await nativeMenu(page, "Download source");
    const rescued = await rescue; await rescued.saveAs(info.outputPath("unsynced-rescued.excalidraw"));
  } finally {
    release?.(); await page.close(); if (bridge) await bridge.close(); await sessions.dispose();
    if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior;
    if (priorRoots === undefined) delete process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS; else process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS = priorRoots;
    await rm(cwd, { recursive: true, force: true });
  }
});
