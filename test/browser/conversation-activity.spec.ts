import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startBridge, type BridgeHost } from "../../src/host/server/transport/bridge.ts";
import { NodeTelemetry } from "../../src/platform/telemetry/telemetry.ts";
import type { SessionView, ViewMessage } from "../../src/host/server/sessions/view.ts";

for (const width of [1440, 390]) test(`agent activity bridges send and first response at ${width}px`, async ({ page }, testInfo) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-activity-browser-"));
  const message = (id: string, text: string, role: ViewMessage["role"] = "assistant"): ViewMessage => ({ id, role, timestamp: new Date().toISOString(), blocks: [{ kind: "text", text }] });
  let session: SessionView = { schemaVersion: 1, sessionId: "activity", cwd, name: "Activity chat", model: "example/model", thinkingLevel: "off", thinkingLevels: ["off"], idle: true, contextUsage: null, messages: [], pluginEntries: [], streaming: null };
  let releaseSend: (() => void) | undefined;
  let rejectSend = false;
  const host: BridgeHost = {
    snapshot: () => session, models: () => [{ provider: "example", id: "model", name: "Example" }], commands: () => [],
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
  await page.addInitScript(({ dark }) => { localStorage.setItem("pi-web-locale", "en"); localStorage.setItem("pi-web-theme", dark ? "dark" : "light"); }, { dark: width === 390 });
  await page.setViewportSize({ width, height: 900 });
  const activity = page.locator("[data-agent-activity]");
  const editor = page.getByRole("textbox", { name: "Send a message to the current Pi session" });
  const publishStream = (streaming: ViewMessage | null) => { session = { ...session, streaming }; bridge.publish({ type: "stream", message: streaming }); };
  try {
    await page.goto(bridge.url);
    await expect(editor).toBeEditable();
    await expect(activity).toHaveCount(0);
    await editor.fill("Draw the current architecture"); await editor.press("Enter");
    await expect(activity).toHaveAttribute("data-agent-activity", "sending");
    await expect(activity).toHaveText("Sending…");
    await expect(page.locator('[data-message-role="user"]')).toHaveCount(1);
    await expect.poll(() => !!releaseSend).toBe(true); releaseSend!();
    await expect(activity).toHaveAttribute("data-agent-activity", "working");
    publishStream(message("stream", ""));
    await expect(activity).toBeVisible();
    await page.reload();
    await expect(activity).toHaveText("Working…");
    await expect(activity.locator("i").first()).toHaveCSS("animation-name", /agent-activity-pulse/);
    await page.screenshot({ path: testInfo.outputPath(`agent-working-${width}.png`) });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(activity.locator("i").first()).toHaveCSS("animation-name", "none");
    await expect(activity.locator("span").last()).toHaveCSS("animation-name", "none");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    publishStream(message("stream", "Here is the architecture"));
    await expect(page.getByText("Here is the architecture", { exact: true })).toBeVisible();
    await expect(activity).toHaveCount(0);
    publishStream({ ...message("stream", ""), blocks: [{ kind: "thinking", text: "Inspecting the project" }] });
    await expect(page.getByText("Inspecting the project", { exact: true })).toBeVisible();
    await expect(activity).toHaveCount(0);
    publishStream({ ...message("stream", ""), blocks: [{ kind: "toolCall", text: '{"command":"pwd"}', toolName: "bash", toolCallId: "call" }] });
    await expect(page.locator('[data-agent-activity]')).toHaveCount(0);
    publishStream(null);
    await expect(activity).toBeVisible();
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
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(activity).toHaveCount(0);

    session = { ...session, idle: false }; bridge.publish({ type: "snapshot", session });
    await expect(activity).toBeVisible();
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
