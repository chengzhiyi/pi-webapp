import { test, expect } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createEventBus, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { requestWebInteraction, WebInteractionHost } from "@chengzhiyi/pi-web-protocol";
import { startBridge, type Bridge } from "../../src/host/server/transport/bridge.ts";
import { NodeTelemetry } from "../../src/platform/telemetry/telemetry.ts";
import { builtinAgentTools } from "../../src/plugins/builtin/server.ts";
import { terminalHost } from "../helpers/terminal-host.ts";

test("Pi types into the visible terminal only after the user allows it", async ({ page }, testInfo) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-terminal-agent-browser-"));
  const { host } = terminalHost(cwd);
  // The session's interaction host, as WorkspaceSessions and the foreground extension provide it.
  const bus = createEventBus();
  let bridge: Bridge | undefined;
  const snapshot = host.snapshot;
  const interactions = new WebInteractionHost(bus, request => request.sessionId === "terminal-a", () => bridge?.publish({ type: "snapshot", session: host.snapshot() }));
  host.snapshot = () => ({ ...snapshot(), interactions: interactions.pending("terminal-a") });
  host.resolvePluginInteraction = async (sessionId, pluginId, requestId, value) => interactions.resolve(sessionId, pluginId, requestId, value);
  bridge = await startBridge(host, fileURLToPath(new URL("../../web/dist/", import.meta.url)), new NodeTelemetry({ env: { PI_WEB_SENTRY_ENABLED: "false" }, monitor: false }), { pluginSettingsFile: join(cwd, "plugins.json") });
  const [send, read] = builtinAgentTools({ run: (...args) => bridge!.runPluginTool(...args), ask: (request, signal) => requestWebInteraction(bus, request, signal) });
  const ctx = { cwd, sessionManager: { getSessionId: () => "terminal-a" } } as unknown as Parameters<ToolDefinition["execute"]>[4];
  const output = (result: { content: Array<{ type: string; text?: string }> }) => result.content.map(item => item.text ?? "").join("");
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.addInitScript(() => localStorage.setItem("pi-web-locale", "en"));
  await page.setViewportSize({ width: 1440, height: 900 });
  const rightbar = page.locator("[data-sidebar-right-session]");
  const screen = rightbar.locator("[data-workspace-terminal]:visible");
  try {
    await page.goto(bridge.url);
    await page.getByRole("button", { name: "Open right sidebar", exact: true }).click();
    await rightbar.getByRole("button", { name: "Open terminal", exact: true }).click();
    await expect(screen).toHaveAttribute("data-terminal-phase", "connected");
    const terminalId = (await screen.getAttribute("data-workspace-terminal"))!;

    // Denied from the composer: nothing reaches the shell and the composer comes back.
    // Settle into a value at once: the refusal can land before the click resolves, and an unobserved rejection fails the test.
    const denied = send!.execute("deny", { terminalId, text: "printf DENIED > denied.txt" }, undefined, undefined, ctx).then(() => "sent", (error: Error) => error.message);
    const prompt = page.getByRole("alertdialog", { name: "Pi wants to type into the terminal" });
    // Shown both in place of the composer and on the targeted terminal tab.
    await expect(prompt).toHaveCount(2);
    const composerCard = page.locator(`[data-terminal-approval="${terminalId}"][data-approval-place="composer"]`);
    await expect(composerCard).toContainText("printf DENIED > denied.txt");
    await expect(screen.locator('[data-approval-place="terminal"]')).toBeVisible();
    await composerCard.getByRole("button", { name: "Deny", exact: true }).click();
    expect(await denied).toMatch(/declined/);
    await expect(prompt).toHaveCount(0);
    expect(await readFile(join(cwd, "denied.txt"), "utf8").catch(() => "missing")).toBe("missing");

    // Fullscreen with the chat hidden: the open floating composer carries the one approval card,
    // and the terminal drops its own copy underneath it.
    await rightbar.getByRole("button", { name: "Fullscreen", exact: true }).click();
    await expect(rightbar).toHaveAttribute("data-sidebar-right-panel", "fullscreen");
    const allowed = send!.execute("allow", { text: "printf 'AGENT_%s\\n' VISIBLE" }, undefined, undefined, ctx);
    const inComposer = page.locator('[data-floating-composer] [data-approval-place="composer"]');
    await expect(inComposer).toContainText("printf 'AGENT_%s\\n' VISIBLE");
    await expect(screen.locator('[data-approval-place="terminal"]')).toBeHidden();
    await page.screenshot({ path: testInfo.outputPath("terminal-agent-approval.png") });
    await inComposer.getByRole("button", { name: "Allow", exact: true }).click();
    await expect(screen.locator(".xterm-rows")).toContainText("AGENT_VISIBLE");
    await expect(prompt).toHaveCount(0);
    const result = output(await allowed);
    expect(result).toContain(`Terminal ${terminalId}`);
    expect(result).toContain("AGENT_VISIBLE");
    expect(output(await read!.execute("read", { terminalId, lines: 3 }, undefined, undefined, ctx))).toContain("AGENT_VISIBLE");
    // Collapsed to its icon, the composer shows no card, so the terminal shows its own and it can be allowed there.
    await page.getByRole("region", { name: "Ask Pi" }).getByRole("button", { name: "Collapse composer" }).click();
    const again = send!.execute("again", { terminalId, text: "printf 'AGAIN_%s\\n' OK" }, undefined, undefined, ctx);
    const onTerminal = screen.locator('[data-approval-place="terminal"]');
    await expect(onTerminal).toBeVisible();
    await onTerminal.getByRole("button", { name: "Allow", exact: true }).click();
    await expect(screen.locator(".xterm-rows")).toContainText("AGAIN_OK");
    expect(output(await again)).toContain("AGAIN_OK");
    expect(errors).toEqual([]);
  } finally { interactions.dispose(); await bridge.close(); await rm(cwd, { recursive: true, force: true }); }
});
