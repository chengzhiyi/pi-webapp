import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startBridge, type BridgeHost } from "../../extension/bridge.ts";
import { NodeTelemetry } from "../../extension/telemetry.ts";
import type { SessionView, ViewMessage } from "../../extension/view.ts";

for (const width of [1440, 768, 320]) test(`streaming respects the reader's scroll position at ${width}px`, async ({ page }, testInfo) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-scroll-browser-"));
  const message = (id: string, text: string): ViewMessage => ({ id, role: "assistant", timestamp: new Date().toISOString(), blocks: [{ kind: "text", text }] });
  const paragraphs = (label: string, count: number) => Array.from({ length: count }, (_, index) => `${label} paragraph ${index + 1}. This is content to read while the response continues.`).join("\n\n");
  let session: SessionView = { schemaVersion: 1, sessionId: "scroll-a", cwd, name: "Scroll chat", model: "example/model", thinkingLevel: "off", thinkingLevels: ["off"], idle: false, contextUsage: null,
    messages: [{ ...message("question", "Previous question"), role: "user" }, message("history", paragraphs("History", 40)), { ...message("request", "Continue with a detailed response"), role: "user" }], pluginEntries: [], streaming: message("stream", paragraphs("Live", 15)) };
  const host: BridgeHost = {
    snapshot: () => session, models: () => [{ provider: "example", id: "model", name: "Example" }], send() {}, abort() {}, async newSession() {}, async setModel() {}, async setThinkingLevel() {},
    config: () => ({ projectTrusted: false, global: { packages: [], extensions: [], skills: [] }, project: { packages: [], extensions: [], skills: [] }, installed: { packages: [], extensions: [], skills: [] } }),
    async updateConfig() { return this.config(); },
    async workspaces() { return { items: [{ id: "a", path: cwd, title: "Scroll workspace" }], activeId: "a", sessions: [] }; },
    async addWorkspace() {}, async selectWorkspace() {}, async newSessionInWorkspace() {}, async removeWorkspace() {}, async selectSession() {},
  };
  const bridge = await startBridge(host, fileURLToPath(new URL("../../web/dist/", import.meta.url)), new NodeTelemetry({ env: { PI_WEB_SENTRY_ENABLED: "false" }, monitor: false }));
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => { localStorage.setItem("pi-web-locale", "en"); });
  await page.setViewportSize({ width, height: 900 });
  const scroll = page.locator("[data-conversation-scroll]");
  const distance = () => scroll.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop);
  const position = () => scroll.evaluate(element => element.scrollTop);
  const publish = async (count: number) => {
    session = { ...session, streaming: message("stream", paragraphs("Live", count)) };
    bridge.publish({ type: "stream", message: session.streaming! });
    await expect(scroll.getByText(`Live paragraph ${count}.`, { exact: false })).toBeAttached();
  };
  const readEarlier = async () => {
    const box = (await scroll.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 80);
    await page.mouse.wheel(0, -550);
    await expect.poll(distance).toBeGreaterThan(300);
    // Wait for the wheel's scroll event before publishing another chunk.
    await expect.poll(position).toBeLessThan(await scroll.evaluate(element => element.scrollHeight - element.clientHeight - 300));
    return position();
  };
  try {
    await page.goto(bridge.url);
    await expect(scroll.getByText("Live paragraph 15.", { exact: false })).toBeAttached();
    await expect.poll(distance).toBeLessThan(2);
    await publish(20);
    await expect.poll(distance).toBeLessThan(2);

    const readingPosition = await readEarlier();
    await publish(25);
    expect(Math.abs(await position() - readingPosition)).toBeLessThan(2);
    const bottom = page.getByRole("button", { name: "Back to latest", exact: true });
    await expect(bottom).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`paused-${width}.png`) });
    await bottom.focus();
    await bottom.press("Enter");
    await expect.poll(distance).toBeLessThan(2);
    await expect(bottom).toHaveCount(0);
    await publish(30);
    await expect.poll(distance).toBeLessThan(2);

    const completionPosition = await readEarlier();
    session = { ...session, idle: true, streaming: null, messages: [...session.messages, message("completed", paragraphs("Live", 35))] };
    bridge.publish({ type: "snapshot", session });
    await expect(scroll.getByText("Live paragraph 35.", { exact: false })).toBeAttached();
    expect(Math.abs(await position() - completionPosition)).toBeLessThan(2);

    // Returning manually to the bottom also resumes following.
    const box = (await scroll.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 80);
    await page.mouse.wheel(0, 10000);
    await expect.poll(distance).toBeLessThan(2);
    await expect(bottom).toHaveCount(0);
    await publish(40);
    await expect.poll(distance).toBeLessThan(2);

    // A different chat opens at its own bottom even with the same message count.
    await readEarlier();
    session = { ...session, sessionId: "scroll-b", messages: [{ ...message("other-question", "Another question"), role: "user" }, message("other-history", paragraphs("Other chat", 45)), { ...message("other-request", "Continue"), role: "user" }, message("other-answer", paragraphs("Other answer", 20))], streaming: null };
    bridge.publish({ type: "snapshot", session });
    await expect(scroll.getByText("Other answer paragraph 20.", { exact: false })).toBeAttached();
    await expect.poll(distance).toBeLessThan(2);

    // Sending restores following, but confirming that echo must not restore it again.
    await readEarlier();
    await page.getByRole("textbox").fill("A new question");
    await page.getByRole("textbox").press("Enter");
    await expect(scroll.getByText("A new question", { exact: true })).toBeVisible();
    await expect.poll(distance).toBeLessThan(2);
    const confirmationPosition = await readEarlier();
    session = { ...session, idle: false, messages: [...session.messages, { ...message("confirmed-user", "A new question"), role: "user" }] };
    bridge.publish({ type: "snapshot", session });
    await expect(scroll.locator('[data-message-role="user"]')).toHaveCount(3);
    await publish(45);
    expect(Math.abs(await position() - confirmationPosition)).toBeLessThan(2);
    expect(errors).toEqual([]);
  } finally {
    await bridge.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
