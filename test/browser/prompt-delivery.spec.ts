import { test, expect } from "@playwright/test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { WorkspaceSessions } from "../../src/host/server/sessions/workspace-sessions.ts";
import { startBridge, type Bridge, type BridgeHost } from "../../src/host/server/transport/bridge.ts";
import { controlledReply } from "../helpers/controlled-reply.ts";

for (const width of [1440, 390]) test(`running composer steers, queues and restores drafts at ${width}px`, async ({ page }, testInfo) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-delivery-browser-")));
  const savedAgent = process.env.PI_CODING_AGENT_DIR;
  const savedPlugins = process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS = "";
  const cwd = join(root, "workspace"); await mkdir(cwd);
  let bridge: Bridge | undefined;
  const sessions = new WorkspaceSessions(event => bridge?.publish(event), () => undefined);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await sessions.open(cwd, "new");
    const session = sessions.session!;
    const reply = await controlledReply(session, "Working on the original request");
    let draining = false;
    const firstStream = session.agent.streamFunction;
    session.agent.streamFunction = async (model, context, options) => {
      if (!draining) return firstStream(model, context, options);
      const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [{ type: "text", text: "Completed" }], stopReason: "stop", timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream(); stream.push({ type: "done", reason: "stop", message }); stream.end(message); return stream;
    };
    await sessions.send("Original request"); await reply.ready;
    let fail = true;
    const host: BridgeHost = {
      snapshot: () => sessions.snapshot(), models: () => [{ provider: session.model!.provider, id: session.model!.id, name: session.model!.name }], commands: () => [],
      send: (_id, text, images, correlation, delivery) => {
        if (fail) throw new Error("Fixture send failed");
        return sessions.send(text, images, correlation, delivery);
      }, abort: () => sessions.stop(), resume: () => sessions.resume(),
      async newSession() {}, async setModel() {}, async setThinkingLevel() {},
      config: () => ({ projectTrusted: false, global: { packages: [], extensions: [], skills: [] }, project: { packages: [], extensions: [], skills: [] }, installed: { packages: [], extensions: [], skills: [] } }),
      async updateConfig() { return this.config(); },
      async workspaces() { return { items: [], activeId: null, sessions: [] }; },
      async addWorkspace() {}, async removeWorkspace() {}, async selectWorkspace() {}, async newSessionInWorkspace() {}, async selectSession() {},
    };
    bridge = await startBridge(host, fileURLToPath(new URL("../../web/dist/", import.meta.url)));
    await page.setViewportSize({ width, height: 900 });
    await page.goto(bridge.url);
    const editor = page.getByRole("textbox");
    const queue = page.getByRole("region", { name: /待处理提示词|Pending prompts/ });
    const queueButton = page.getByRole("button", { name: /^(排队|Queue)$/ });
    const steerButton = page.getByRole("button", { name: /^(引导|Steer)$/ });
    const pause = page.getByRole("button", { name: /^(暂停执行|Pause)$/ });
    await expect(queueButton).toBeDisabled();
    await editor.fill("Follow-up one");
    await queueButton.click();
    await expect(editor).toHaveText("Follow-up one");
    await expect(page.getByRole("alert")).toContainText("Fixture send failed");
    await expect(queue).toHaveCount(0);
    fail = false;
    await editor.press("Enter");
    await expect(editor).toHaveText("");
    await expect(queue).toContainText("Follow-up one");
    await expect(page.locator('[data-message-role="user"]')).toHaveCount(1);
    await expect(pause).toBeEnabled();
    await editor.fill("Guide the current task");
    await editor.press("Control+Enter");
    await expect(queue).toContainText("Guide the current task");
    await editor.fill("Another guide");
    await steerButton.click();
    await expect(queue).toContainText("Another guide");
    await expect(editor).toHaveText("");
    // Running uploads work and a queued image is displayed as a file, not a phantom user turn.
    await page.getByRole("button", { name: /^(添加指令|Add command)$/ }).click();
    await expect(page.getByRole("option")).toHaveCount(1, { timeout: 3000 });
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("option", { name: /文件|File/ }).click();
    await (await chooser).setFiles({ name: "hint.txt", mimeType: "text/plain", buffer: Buffer.from("extra context") });
    await expect(queueButton).toBeEnabled();
    await queueButton.click();
    await expect(queue).toContainText("hint.txt");
    await expect(page.locator('[data-message-role="user"]')).toHaveCount(1);
    await editor.fill("/new");
    await expect(queueButton).toBeDisabled();
    await expect(steerButton).toBeDisabled();
    await editor.fill("");
    await page.reload();
    await expect(queue).toContainText("Follow-up one");
    await expect(queue).toContainText("hint.txt");
    await expect(pause).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`prompt-queue-${width}.png`) });
    // Finish without network, then let the native queue drain.
    draining = true;
    reply.finish(); await session.waitForIdle();
    await expect(queue).toHaveCount(0);
    await expect(page.locator('[data-message-role="user"]')).toHaveCount(5);
    await expect(page.getByRole("button", { name: /^(发送消息|Send message)$/ })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await sessions.dispose(); await bridge?.close();
    if (savedAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedAgent;
    if (savedPlugins === undefined) delete process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS; else process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS = savedPlugins;
    await rm(root, { recursive: true, force: true });
  }
});
