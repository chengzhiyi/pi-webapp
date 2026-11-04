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
  let session: SessionView = { schemaVersion: 1, sessionId: "activity", cwd, name: "A session title that should use the available conversation header width instead of stopping at two hundred and twenty pixels", model: "example/model", thinkingLevel: "off", thinkingLevels: ["off"], idle: true, contextUsage: null, messages: [], pluginEntries: [], streaming: null };
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
    const headerTitle = page.locator('[class*="crumbCurrent"]');
    const titleSize = await headerTitle.evaluate(element => ({ client: element.clientWidth, content: element.scrollWidth }));
    if (width === 1440) {
      expect(titleSize.client).toBeGreaterThan(220);
      expect(titleSize.content).toBeLessThanOrEqual(titleSize.client + 1);
    } else expect(titleSize.content).toBeGreaterThanOrEqual(titleSize.client);
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
    await expect(activity).toHaveText(width === 1440 ? "Working · 12s" : "正在处理 · 12s");
    await expect(activity.locator('[aria-hidden="true"]').first()).toHaveCSS("animation-name", /agent-activity-breathe/);
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
    // Assert on this failure's own toast: the fake clock can also time out a slow plugin load.
    const toasts = page.locator("[data-toast-viewport]");
    const sendFailure = toasts.getByRole("alert").filter({ hasText: "Fixture send failed" });
    await expect(sendFailure).toBeVisible();
    await expect(activity).toHaveCount(0);
    await expect(editor).toHaveText("Failed request");
    await sendFailure.getByRole("button", { name: /^(关闭|Dismiss)$/ }).click();
    await expect(sendFailure).toHaveCount(0);
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
    // A different running session starts at zero; returning resumes the original background clock.
    const runningSessionId = session.sessionId;
    await page.clock.fastForward(4000);
    session = { ...session, sessionId: "another-running-session" }; bridge.publish({ type: "snapshot", session });
    await expect(elapsed).toHaveAttribute("data-agent-elapsed", "0");
    await page.clock.fastForward(4000);
    session = { ...session, sessionId: runningSessionId }; bridge.publish({ type: "snapshot", session });
    await expect(elapsed).toHaveAttribute("data-agent-elapsed", "8");
    // A background completion and new run has a new activity id, so it must not reuse the old clock.
    const restartedSession = { ...session, activityId: (session.activityId ?? 0) + 1 };
    session = { ...session, sessionId: "another-running-session" }; bridge.publish({ type: "snapshot", session });
    session = restartedSession; bridge.publish({ type: "snapshot", session });
    await expect(elapsed).toHaveAttribute("data-agent-elapsed", "0");
    const modelFailure = '400 {"type":"error","error":{"type":"invalid_request_error","message":"Model failed"},"request_id":"req_fixture"}';
    session = { ...session, idle: true, messages: [...session.messages, { ...message("error", ""), blocks: [], error: modelFailure }] };
    bridge.publish({ type: "snapshot", session });
    bridge.publish({ type: "error", message: modelFailure, inTranscript: true });
    const card = page.locator(".pi-model-error");
    await expect(card.locator(".pi-model-error-message")).toHaveText("Model failed");
    await expect(card.locator(".pi-model-error-meta")).toHaveText("HTTP 400 · invalid_request_error");
    await expect(card.locator(".pi-model-error-request")).toHaveText("req_fixture");
    if (process.env.PI_ERROR_SCREENSHOT) await card.screenshot({ path: `${process.env.PI_ERROR_SCREENSHOT}-${width}.png` });
    // The transcript card already reports this failure; no toast repeats it.
    await expect(toasts.getByRole("alert").filter({ hasText: "Model failed" })).toHaveCount(0);
    await expect(activity).toHaveCount(0);
    // A retry clears both stale presentations as soon as Pi produces a new response.
    const recovered = message("stream", "Recovered response\n\n```ts\nconst answer = 42;\n```");
    session = { ...session, idle: false, streaming: recovered };
    bridge.publish({ type: "stream", message: recovered });
    await expect(page.locator(".pi-model-error")).toHaveCount(0);
    await expect(page.getByText("Recovered response", { exact: true })).toBeVisible();
    // Model code blocks and replies still copy when Electron denies the async Clipboard API.
    await page.evaluate(() => {
      Object.assign(window, { copiedText: "" });
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: () => Promise.reject(new Error("Clipboard denied")) } });
      document.execCommand = command => {
        if (command !== "copy") return false;
        Object.assign(window, { copiedText: (document.activeElement as HTMLTextAreaElement | null)?.value ?? "" });
        return true;
      };
    });
    const copiedText = () => page.evaluate(() => (window as Window & { copiedText?: string }).copiedText);
    const copyCode = page.locator(".md-code-block").first().getByRole("button", { name: /^(复制|Copy|已复制|Copied)$/ });
    await copyCode.click();
    await expect(copyCode).toHaveAccessibleName(/^(已复制|Copied)$/);
    expect(await copiedText()).toBe("const answer = 42;");
    // The fallback's temporary textarea hands focus back to the clicked control.
    await expect(copyCode).toBeFocused();
    // The finished reply's copy action takes the same fallback.
    const copyReply = page.getByRole("button", { name: /^(复制回复|Copy reply)$/ });
    const earlierReplies = await copyReply.count();
    session = { ...session, idle: true, streaming: null, messages: [...session.messages, { ...recovered, id: "recovered" }] };
    bridge.publish({ type: "snapshot", session });
    await expect(copyReply).toHaveCount(earlierReplies + 1);
    await copyReply.last().click();
    await expect.poll(copiedText).toBe("Recovered response\n\n```ts\nconst answer = 42;\n```");
    // The reply button relabels itself once the fallback write succeeds, and keeps focus.
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toMatch(/^(已复制|Copied)$/);
    session = { ...session, sessionId: "other-session", idle: true, messages: [], streaming: null }; bridge.publish({ type: "snapshot", session });
    await expect(activity).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    releaseSend?.();
    await bridge.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
