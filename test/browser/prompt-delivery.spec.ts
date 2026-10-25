import { emptyHosted } from "../helpers/empty-hosted.ts";
import { test, expect } from "@playwright/test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { WorkspaceSessions } from "../../src/host/server/sessions/workspace-sessions.ts";
import { startBridge, type Bridge, type BridgeHost } from "../../src/host/server/transport/bridge.ts";
import { controlledReply } from "../helpers/controlled-reply.ts";

for (const width of [1440, 390, 320]) test(`DSH send → queue → edit/delete/steer at ${width}px`, async ({ page }, testInfo) => {
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
    let fail = true, failQueue = false, holdEdit = false;
    let releaseEdit: (() => void) | undefined;
    const host: BridgeHost = {
      hosted: emptyHosted,
      snapshot: () => sessions.snapshot(), models: () => [{ provider: session.model!.provider, id: session.model!.id, name: session.model!.name }], commands: () => [],
      send: (_id, text, images, correlation, delivery) => {
        if (fail) throw new Error("Fixture send failed");
        return sessions.send(text, images, correlation, delivery);
      },
      async updateQueuedPrompt(_sessionId, id, revision, action) {
        if (failQueue) throw new Error("Fixture queue action failed");
        if (holdEdit && action.kind === "edit") await new Promise<void>(resolve => { releaseEdit = resolve; });
        await sessions.updateQueuedPrompt(id, revision, action);
      },
      abort: () => sessions.stop(), resume: () => sessions.resume(),
      async newSession() {}, async setModel() {}, async setThinkingLevel() {},
      config: () => ({ projectTrusted: false, global: { packages: [], extensions: [], skills: [] }, project: { packages: [], extensions: [], skills: [] }, installed: { packages: [], extensions: [], skills: [] } }),
      async updateConfig() { return this.config(); },
      async workspaces() { return { items: [], activeId: null, sessions: [] }; },
      async addWorkspace() {}, async removeWorkspace() {}, async selectWorkspace() {}, async newSessionInWorkspace() {}, async selectSession() {},
    };
    bridge = await startBridge(host, fileURLToPath(new URL("../../web/dist/", import.meta.url)));
    await page.setViewportSize({ width, height: 900 });
    if (width === 390) await page.addInitScript(() => localStorage.setItem("pi-web-theme", "dark"));
    await page.goto(bridge.url);
    const editor = page.getByRole("textbox", { name: /给当前 Pi 会话发送消息|Send a message to the current Pi session/ });
    const inline = page.getByRole("textbox", { name: /编辑排队提示词|Edit queued prompt/ });
    const queue = page.getByRole("region", { name: /待处理提示词|Pending prompts/ });
    const send = page.getByRole("button", { name: /^(发送消息|Send message)$/ });
    const pause = page.getByRole("button", { name: /^(暂停执行|Pause)$/ });
    const row = (text: string) => queue.getByRole("listitem").filter({ hasText: text });
    const edit = (text: string) => row(text).getByRole("button", { name: /^(编辑|Edit)$/ });
    const expand = async () => {
      const toggle = queue.getByRole("button", { name: /pending prompts|条待处理提示词/ });
      if (await toggle.count() && await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
    };
    await expect(pause).toBeEnabled();
    await expect(send).toHaveCount(0);
    await editor.fill("Follow-up one");
    await expect(send).toBeEnabled();
    await expect(pause).toHaveCSS("width", "28px");
    await send.click();
    await expect(editor).toHaveText("Follow-up one");
    await expect(page.getByRole("alert")).toContainText("Fixture send failed");
    fail = false;
    await editor.press("Enter");
    await expect(editor).toHaveText("");
    await expect(row("Follow-up one")).toBeVisible();
    await expect(row("Follow-up one").getByRole("button")).toHaveCount(3);
    await expect(page.locator('[data-message-role="user"]')).toHaveCount(1);

    // Editing is in place, not a destructive move back into the composer.
    await edit("Follow-up one").click();
    await inline.fill("Cancelled edit");
    await inline.press("Escape");
    await expect(row("Follow-up one")).toBeVisible();
    await edit("Follow-up one").click();
    await inline.fill("Revised follow-up");
    holdEdit = true;
    await inline.press("Enter");
    await expect.poll(() => !!releaseEdit).toBe(true);
    await editor.fill("New draft while saving");
    holdEdit = false; releaseEdit!();
    await expect(edit("Revised follow-up")).toBeEnabled();
    await expect(editor).toBeFocused();
    await expect(editor).toHaveText("New draft while saving");
    await editor.fill("");
    failQueue = true;
    await row("Revised follow-up").getByRole("button", { name: /发送（引导）|Send \(steer\)/ }).click();
    await expect(queue.getByRole("alert")).toContainText("Fixture queue action failed");
    await expect(edit("Revised follow-up")).toBeEnabled();
    failQueue = false;
    await row("Revised follow-up").getByRole("button", { name: /发送（引导）|Send \(steer\)/ }).click();
    await expect(edit("Revised follow-up")).toHaveCount(0);
    await expect.poll(() => session.getSteeringMessages().includes("Revised follow-up")).toBe(true);

    await editor.fill("Delete me"); await send.click();
    await expect(queue).toContainText("Delete me"); await expand();
    await row("Delete me").getByRole("button", { name: /^(删除|Delete)$/ }).click();
    await expect(row("Delete me")).toHaveCount(0);
    await expect(page.locator('[data-message-role="user"]')).toHaveCount(1);
    await editor.fill("Keep attachment");
    await page.getByRole("button", { name: /^(添加指令|Add command)$/ }).click();
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("option", { name: /文件|File/ }).click();
    await (await chooser).setFiles({ name: "hint.txt", mimeType: "text/plain", buffer: Buffer.from("extra context") });
    await expect(send).toBeEnabled(); await send.click();
    await expect(queue).toContainText("Keep attachment"); await expand();
    await edit("Keep attachment").click();
    await expect(inline).toHaveValue("Keep attachment");
    await inline.fill("Attachment edited"); await inline.press("Enter");
    await expect(row("Attachment edited")).toContainText("hint.txt");
    await editor.fill("Automatic tail"); await send.click();
    await page.reload();
    const toggle = queue.getByRole("button", { name: /pending prompts|条待处理提示词/ });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await page.screenshot({ path: testInfo.outputPath(`prompt-queue-collapsed-${width}.png`) });
    await toggle.focus(); await toggle.press("Enter");
    await expect(edit("Attachment edited")).toBeEnabled();
    await expect(queue.getByRole("listitem")).toHaveCount(3);
    await page.screenshot({ path: testInfo.outputPath(`prompt-queue-actions-${width}.png`) });
    await edit("Automatic tail").click();
    await inline.fill("Final queued task");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`prompt-queue-edit-${width}.png`) });
    await inline.press("Enter");
    await expect(edit("Final queued task")).toBeFocused();
    await editor.fill("/new"); await expect(send).toBeDisabled(); await expect(pause).toBeEnabled(); await editor.fill("");
    await expect(editor).toHaveText("");
    // Stop keeps the editable queue; Continue drains it after the original work.
    await pause.click();
    await expect.poll(() => session.isIdle).toBe(true);
    await expect(edit("Final queued task")).toBeEnabled();
    await expect(row("Final queued task").getByRole("button", { name: /发送（引导）|Send \(steer\)/ })).toBeDisabled();
    draining = true;
    await page.getByRole("button", { name: /^(继续执行|Continue)$/ }).click();
    await expect(queue).toHaveCount(0);
    await expect(page.locator('[data-message-role="user"]')).toHaveCount(4);
    await expect(send).toBeVisible();
    expect(sessions.snapshot().messages.some(message => message.blocks.some(block => block.text.includes("Delete me")))).toBe(false);
    expect(errors).toEqual([]);
  } finally {
    await sessions.dispose(); await bridge?.close();
    if (savedAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedAgent;
    if (savedPlugins === undefined) delete process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS; else process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS = savedPlugins;
    await rm(root, { recursive: true, force: true });
  }
});
