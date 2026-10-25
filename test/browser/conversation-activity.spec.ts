import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startBridge, type BridgeHost } from "../../src/host/server/transport/bridge.ts";
import { NodeTelemetry } from "../../src/platform/telemetry/telemetry.ts";
import type { SessionView, ViewMessage } from "../../src/host/server/sessions/view.ts";

for (const width of [1440, 390, 320]) test(`agent activity bridges send and first response at ${width}px`, async ({ page }, testInfo) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-activity-browser-"));
  const message = (id: string, text: string, role: ViewMessage["role"] = "assistant"): ViewMessage => ({ id, role, timestamp: new Date().toISOString(), blocks: [{ kind: "text", text }] });
  let session: SessionView = { schemaVersion: 1, sessionId: "activity", cwd, name: "Activity chat", model: "example/model", thinkingLevel: "off", thinkingLevels: ["off"], idle: true, contextUsage: null, messages: [], pluginEntries: [], streaming: null };
  let releaseSend: (() => void) | undefined;
  let rejectSend = false;
  const host: BridgeHost = {
    snapshot: () => session, models: () => [{ provider: "example", id: "model", name: "Example" }], commands: () => [],
    // This activity-only fixture has no installed plugins. Model the hosted
    // inventory explicitly, rather than making bootstrap fail with a 503 alert.
    hosted: {
      inventory: async () => ({ plugins: [] }),
      manage: async () => { throw new Error("No hosted fixture management"); },
      action: async () => { throw new Error("No hosted fixture actions"); },
      views: async () => { throw new Error("No hosted fixture views"); },
      asset: async () => null,
    },
    async send(_id, text) {
      if (rejectSend) throw new Error("Fixture send failed");
      await new Promise<void>(resolve => { releaseSend = resolve; });
      session = { ...session, idle: false, messages: [...session.messages, message(`user-${session.messages.length}`, text, "user")] };
      bridge.publish({ type: "snapshot", session });
    },
    abort() { session = { ...session, idle: true, streaming: null }; bridge.publish({ type: "snapshot", session }); },
    async newSession() {}, async setModel() {}, async setThinkingLevel() {},
    config: () => ({ projectTrusted: false, global: { packages: [], extensions: [], skills: [] }, project: { packages: [], extensions: [], skills: [] }, installed: { packages: [], extensions: [], skills: [] } }),
    async updateConfig() { return this.config(); },
    async workspaces() { return { items: [], activeId: null, sessions: [] }; },
    async addWorkspace() {}, async selectWorkspace() {}, async newSessionInWorkspace() {}, async removeWorkspace() {}, async selectSession() {},
  };
  const bridge = await startBridge(host, fileURLToPath(new URL("../../web/dist/", import.meta.url)), new NodeTelemetry({ env: { PI_WEB_SENTRY_ENABLED: "false" }, monitor: false }));
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(({ dark }) => { localStorage.setItem("pi-web-locale", dark ? "zh" : "en"); localStorage.setItem("pi-web-theme", dark ? "dark" : "light"); }, { dark: width !== 1440 });
  await page.setViewportSize({ width, height: 900 });
  const activity = page.locator("[data-agent-activity]");
  const editor = page.getByRole("textbox", { name: /给当前 Pi 会话发送消息|Send a message to the current Pi session/ });
  const elapsed = activity.locator("[data-agent-elapsed]");
  const publishStream = (streaming: ViewMessage | null) => { session = { ...session, streaming }; bridge.publish({ type: "stream", message: streaming }); };
  try {
    await page.goto(bridge.url);
    await expect(editor).toBeEditable();
    await expect(activity).toHaveCount(0);
    await page.clock.install();
    await editor.fill("Draw the current architecture"); await editor.press("Enter");
    await expect(activity).toHaveAttribute("data-agent-activity", "sending");
    await expect(activity.getByRole("status")).toHaveText(/^(正在发送|Sending)$/);
    await expect(page.locator('[data-message-role="user"]')).toHaveCount(1);
    await page.clock.fastForward(2000);
    await expect(elapsed).toHaveAttribute("data-agent-elapsed", "2");
    await expect.poll(() => !!releaseSend).toBe(true); releaseSend!();
    await expect(activity).toHaveAttribute("data-agent-activity", "working");
    await expect(elapsed).toHaveAttribute("data-agent-elapsed", "2");
    publishStream(message("stream", ""));
    await expect(activity).toBeVisible();
    await page.reload();
    await expect(activity.getByRole("status")).toHaveText(/^(正在处理|Working)$/);
    await expect(elapsed).toHaveAttribute("data-agent-elapsed", "0");
    await page.clock.fastForward(12000);
    await expect(elapsed).toHaveAttribute("data-agent-elapsed", "12");
    await expect(activity).toHaveText(width === 1440 ? "Working, 12s elapsed…" : "正在处理，用时 12 秒…");
    await expect(activity.locator('[aria-hidden="true"]').first()).toHaveCSS("animation-name", /agent-activity-spin/);
    await expect(elapsed).toHaveAttribute("aria-hidden", "true");
    // Compare the icon with the copy and both text spans, catching inherited
    // top alignment even when the outer row itself uses align-items: center.
    const expectAligned = async () => {
      const offsets = await activity.evaluate(root => {
        const icon = root.querySelector("svg")!.getBoundingClientRect();
        const status = root.querySelector('[role="status"]')!.getBoundingClientRect();
        const timer = root.querySelector("[data-agent-elapsed]")!.getBoundingClientRect();
        const copy = root.lastElementChild!.getBoundingClientRect();
        return {
          lineCenter: Math.abs(icon.y + icon.height / 2 - status.y - status.height / 2),
          copyCenter: Math.abs(icon.y + icon.height / 2 - copy.y - copy.height / 2),
          sameLine: Math.abs(timer.y - status.y),
        };
      });
      expect(offsets.lineCenter).toBeLessThanOrEqual(0.5);
      expect(offsets.copyCenter).toBeLessThanOrEqual(0.5);
      expect(offsets.sameLine).toBeLessThanOrEqual(0.5);
    };
    await expectAligned();
    await page.screenshot({ path: testInfo.outputPath(`agent-working-${width}.png`) });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(activity.locator('[aria-hidden="true"]').first()).toHaveCSS("animation-name", "none");
    await expect(activity.locator(":scope > span").last()).toHaveCSS("animation-name", "none");
    for (const fontSize of [12, 16, 20]) {
      await page.evaluate(size => document.documentElement.style.setProperty("--piw-content-font-size", `${size}px`), fontSize);
      await expectAligned();
    }
    await page.evaluate(() => document.documentElement.style.removeProperty("--piw-content-font-size"));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    publishStream(message("stream", "Here is the architecture"));
    await expect(page.getByText("Here is the architecture", { exact: true })).toBeVisible();
    await expect(activity).toHaveCount(0);
    publishStream({ ...message("stream", ""), blocks: [{ kind: "thinking", text: "Inspecting the project" }] });
    await expect(page.getByText("Inspecting the project", { exact: true })).toBeVisible();
    await expect(activity).toHaveCount(0);
    publishStream({ ...message("stream", ""), blocks: [{ kind: "toolCall", text: '{"command":"pwd"}', toolName: "bash", toolCallId: "call" }] });
    await expect(page.locator('[data-agent-activity]')).toHaveCount(0);
    await page.clock.fastForward(3000);
    publishStream(null);
    await expect(activity).toBeVisible();
    await expect(elapsed).toHaveAttribute("data-agent-elapsed", "15");
    session = { ...session, idle: true, messages: [...session.messages, message("answer", "Done")] };
    bridge.publish({ type: "snapshot", session });
    await expect(activity).toHaveCount(0);

    // Send errors remove the optimistic placeholder and restore the draft.
    rejectSend = true;
    await editor.fill("Failed request"); await editor.press("Enter");
    await expect(page.getByRole("alert")).toContainText("Fixture send failed");
    await expect(activity).toHaveCount(0);
    await expect(editor).toHaveText("Failed request");
    rejectSend = false; releaseSend = undefined;
    await editor.press("Enter");
    await expect(activity).toHaveAttribute("data-agent-activity", "sending");
    await expect.poll(() => !!releaseSend).toBe(true); releaseSend!();
    await expect(activity).toHaveAttribute("data-agent-activity", "working");
    await page.getByRole("button", { name: /^(暂停执行|Pause)$/ }).click();
    await expect(activity).toHaveCount(0);

    session = { ...session, idle: false }; bridge.publish({ type: "snapshot", session });
    await expect(activity).toBeVisible();
    await expect(elapsed).toHaveAttribute("data-agent-elapsed", "0");
    // A running session switch starts a distinct clock, never reuses the previous elapsed time.
    await page.clock.fastForward(4000);
    session = { ...session, sessionId: "another-running-session" }; bridge.publish({ type: "snapshot", session });
    await expect(elapsed).toHaveAttribute("data-agent-elapsed", "0");
    session = { ...session, idle: true, messages: [...session.messages, { ...message("error", ""), blocks: [], error: "Model failed" }] };
    bridge.publish({ type: "snapshot", session });
    await expect(page.getByRole("alert")).toContainText("Model failed");
    await expect(activity).toHaveCount(0);
    session = { ...session, sessionId: "other-session", messages: [] }; bridge.publish({ type: "snapshot", session });
    await expect(activity).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    releaseSend?.();
    await bridge.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
