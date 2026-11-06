import { emptyHosted } from "../helpers/empty-hosted.ts";
import { test, expect } from "@playwright/test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { WorkspaceSessions } from "../../src/host/server/sessions/workspace-sessions.ts";
import { startBridge, type Bridge, type BridgeHost } from "../../src/host/server/transport/bridge.ts";
import { controlledReply } from "../helpers/controlled-reply.ts";

const shots = process.env.PI_FLOATING_SHOTS;
const shot = async (page: import("@playwright/test").Page, name: string) => { if (!shots) return; await page.waitForTimeout(500); await page.screenshot({ path: join(shots, `${name}.png`) }); };

test("the composer floats over a focused workspace, shares the draft, reports replies and remembers its place", async ({ page }) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-floating-composer-")));
  const savedAgent = process.env.PI_CODING_AGENT_DIR;
  const savedPlugins = process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS = "";
  const cwd = join(root, "workspace"); await mkdir(cwd);
  await writeFile(join(cwd, "notes.txt"), Array.from({ length: 80 }, (_, index) => `line ${index + 1}`).join("\n"));
  let bridge: Bridge | undefined;
  const sessions = new WorkspaceSessions(event => bridge?.publish(event), () => undefined);
  const errors: string[] = [];
  const sent: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await sessions.open(cwd, "new");
    const session = sessions.session!;
    const reply = await controlledReply(session, "Aligned both shapes and added labels.");
    const host: BridgeHost = {
      hosted: emptyHosted,
      snapshot: () => sessions.snapshot(), models: () => [{ provider: session.model!.provider, id: session.model!.id, name: session.model!.name }], commands: () => [],
      send: (_id, text, images, correlation, delivery) => { sent.push(text); return sessions.send(text, images, correlation, delivery); },
      async updateQueuedPrompt(_sessionId, id, revision, action) { await sessions.updateQueuedPrompt(id, revision, action); },
      abort: () => sessions.stop(), resume: () => sessions.resume(),
      async newSession() {}, async setModel() {}, async setThinkingLevel() {},
      config: () => ({ projectTrusted: false, global: { packages: [], extensions: [], skills: [] }, project: { packages: [], extensions: [], skills: [] }, installed: { packages: [], extensions: [], skills: [] } }),
      async updateConfig() { return this.config(); },
      async workspaces() { return { items: [], activeId: null, sessions: [] }; },
      async addWorkspace() {}, async removeWorkspace() {}, async selectWorkspace() {}, async newSessionInWorkspace() {}, async selectSession() {},
    };
    bridge = await startBridge(host, fileURLToPath(new URL("../../web/dist/", import.meta.url)));
    await page.addInitScript(() => localStorage.setItem("pi-web-locale", "en"));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(bridge.url);

    const panel = page.locator("[data-sidebar-right-session]");
    const floating = page.locator("[data-floating-composer]");
    const mainEditor = page.getByRole("textbox", { name: "Send a message to the current Pi session" });
    await mainEditor.fill("Draft typed in the chat");
    await page.getByRole("button", { name: "Open right sidebar" }).click();
    await panel.getByRole("button", { name: "Workspace files", exact: true }).click();
    await expect(panel).toHaveAttribute("data-sidebar-right-panel", "push");
    // The conversation is visible beside the panel: one composer only.
    await expect(floating).toHaveCount(0);

    await panel.getByRole("button", { name: "Fullscreen", exact: true }).click();
    await expect(panel).toHaveAttribute("data-sidebar-right-panel", "fullscreen");
    await expect(floating).toHaveAttribute("data-floating-composer", "expanded");
    const region = page.getByRole("region", { name: "Ask Pi" });
    const editor = region.getByRole("textbox", { name: "Send a message to the current Pi session" });
    // Same draft, moved: nothing was copied between two composers.
    await expect(editor).toHaveText("Draft typed in the chat");
    const chip = region.locator("[data-floating-context]");
    await expect(chip).toContainText("Files");
    // It sits at the bottom centre of the panel body, clear of the tab strip.
    const panelBox = (await panel.boundingBox())!;
    // Polled: the 160ms entry scale settles first.
    await expect.poll(async () => { const box = (await floating.boundingBox())!; return Math.round(panelBox.y + panelBox.height - (box.y + box.height)); }).toBe(16);
    const box = (await floating.boundingBox())!;
    expect(Math.abs(box.x + box.width / 2 - (panelBox.x + panelBox.width / 2))).toBeLessThan(2);
    await shot(page, "1-expanded");

    // Open a file: on a wide panel the bar takes no height (no blank strip); the editor only gains
    // room to scroll its last lines clear of the bar.
    await panel.getByRole("treeitem", { name: /notes\.txt/ }).click();
    const code = panel.locator(".cm-content:visible");
    await expect(code).toBeVisible();
    expect(await panel.evaluate(element => element.style.getPropertyValue("--pi-floating-composer-inset"))).toBe("");
    expect(Number.parseFloat(await panel.evaluate(element => element.style.getPropertyValue("--pi-floating-composer-overlap")))).toBeGreaterThan(40);
    const content = (await panel.locator('[data-dockkit-host="dock"] > [data-dockkit-content]:visible').boundingBox())!;
    expect(content.y + content.height).toBeCloseTo(panelBox.y + panelBox.height, 0);
    // The chip names the open file, then the selected lines.
    await expect(chip).toContainText("notes.txt");
    await code.getByText("line 2", { exact: true }).click();
    await code.getByText("line 4", { exact: true }).click({ modifiers: ["Shift"] });
    await expect(chip).toContainText("notes.txt · L2–4");

    await editor.fill("Explain these notes");
    await expect(chip).toHaveAttribute("data-pinned", "true");
    await editor.press("Enter");
    await reply.ready;
    await expect(region.locator("[data-floating-status]")).toContainText(/Writing a reply|Working/);
    await expect(page.locator("[data-floating-status]")).toContainText("Aligned both shapes");
    await shot(page, "2-working");
    await expect.poll(() => sent.at(-1)).toContain("Explain these notes\n\n[pi-web workspace tab in view] ");
    // The agent reads which file and lines "these" means, and is told to act on them in place.
    expect(sent.at(-1)).toContain('"reference":"Open file: notes.txt');
    expect(sent.at(-1)).toContain("Selected lines 2–4.");
    expect(sent.at(-1)).toContain("act on it in place instead of creating something new");

    reply.finish();
    await expect(region.getByRole("status").filter({ hasText: "Pi replied" })).toBeVisible();
    await expect(region.locator("[data-floating-status]")).toContainText("Aligned both shapes and added labels.");
    await shot(page, "3-reply");

    // The conversation unfolds in place and folds away again.
    await region.locator("[data-floating-status]").getByRole("button", { name: "Show conversation" }).click();
    const transcript = region.locator("[data-floating-transcript]");
    await expect(transcript).toContainText("Explain these notes");
    await expect(transcript).toContainText("Aligned both shapes and added labels.");
    await expect(transcript.locator("[data-message-context]")).toContainText("notes.txt · L2–4");
    await expect(region.getByRole("button", { name: "Hide conversation" }).first()).toHaveAttribute("aria-expanded", "true");
    await shot(page, "3b-conversation");
    await transcript.getByRole("button", { name: "Hide conversation" }).click();
    await expect(transcript).toHaveCount(0);
    await region.getByRole("button", { name: "Show conversation" }).click();
    await expect(transcript).toBeVisible();
    // The command menu takes the space above the bar: the conversation folds away under it, then returns.
    await region.getByRole("button", { name: "Add command" }).click();
    await expect(region.getByRole("listbox", { name: "Commands" })).toBeVisible();
    await expect(transcript).toHaveCount(0);
    await region.getByRole("button", { name: "Add command" }).click();
    await expect(transcript).toBeVisible();
    await region.getByRole("button", { name: "Hide conversation" }).last().click();
    // The session's model can be switched from the bar.
    const model = region.locator("[data-floating-model]").getByRole("button", { name: /^Change model/ });
    await expect(model).toBeVisible();
    // An icon, not a name chip: it takes no more room than the row's other buttons.
    expect(Math.round((await model.boundingBox())!.width)).toBe(32);
    await expect(model).toHaveAttribute("title", /\S/);
    await model.click();
    await expect(page.getByRole("dialog").or(page.getByRole("menu")).or(page.getByRole("listbox")).first()).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(transcript).toHaveCount(0);

    // Collapse to the icon, then ⌘J / Ctrl+J brings the bar back with focus.
    await region.getByRole("button", { name: "Collapse composer" }).click();
    await expect(floating).toHaveAttribute("data-floating-composer", "collapsed");
    // The reply was read in the unfolded conversation, so the icon is back to idle.
    await expect(page.getByRole("button", { name: /^Ask Pi/ })).toHaveAttribute("data-state", "idle");
    await shot(page, "4-collapsed");
    await page.keyboard.press(process.platform === "darwin" ? "Meta+j" : "Control+j");
    await expect(floating).toHaveAttribute("data-floating-composer", "expanded");
    await expect(editor).toBeFocused();
    // Esc hands focus back without clearing or collapsing.
    await editor.fill("Kept draft");
    await editor.press("Escape");
    await expect(editor).not.toBeFocused();
    await expect(floating).toHaveAttribute("data-floating-composer", "expanded");

    // Drag the grip near the top-left corner: it snaps there and opens downward.
    const grip = region.getByRole("button", { name: /Move composer/ });
    const gripBox = (await grip.boundingBox())!;
    await page.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y + gripBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(panelBox.x + 40, panelBox.y + 120, { steps: 10 });
    // An outline shows where the composer will land.
    await expect(page.locator("[data-floating-snap-target]")).toBeVisible();
    await shot(page, "5-dragging");
    await page.mouse.up();
    await expect(floating).toHaveAttribute("data-edge", "top");
    const moved = (await floating.boundingBox())!;
    expect(moved.x - panelBox.x).toBeCloseTo(12, 0);
    const inMoved = await panel.evaluate(element => getComputedStyle(element).getPropertyValue("--pi-floating-composer-inset"));
    expect(inMoved.trim()).toBe("");
    // The place survives a reload.
    await page.reload();
    await page.getByRole("button", { name: "Open right sidebar" }).click();
    const guideFiles = panel.getByRole("button", { name: "Workspace files", exact: true });
    if (await guideFiles.isVisible()) await guideFiles.click();
    await panel.getByRole("button", { name: "Fullscreen", exact: true }).click();
    await expect(floating).toHaveAttribute("data-edge", "top");
    // Double-click resets to the bottom centre.
    await page.getByRole("region", { name: "Ask Pi" }).getByRole("button", { name: /Move composer/ }).dblclick();
    await expect(floating).toHaveAttribute("data-edge", "bottom");

    // Leaving fullscreen hands the draft back to the docked composer; the transcript hides the reference.
    await page.getByRole("region", { name: "Ask Pi" }).getByRole("textbox").fill("Back to chat");
    await panel.getByRole("button", { name: "Exit fullscreen" }).click();
    await expect(floating).toHaveCount(0);
    await expect(mainEditor).toHaveText("Back to chat");
    const message = page.locator('[data-message-role="user"]').filter({ hasText: "Explain these notes" });
    await expect(message.locator("[data-message-context]")).toContainText("From notes.txt · L2–4");
    await expect(message).not.toContainText("pi-web workspace tab in view");
    await shot(page, "6-transcript");
    expect(errors).toEqual([]);
  } finally {
    await bridge?.close();
    await sessions.dispose?.();
    if (savedAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedAgent;
    if (savedPlugins === undefined) delete process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS; else process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS = savedPlugins;
    await rm(root, { recursive: true, force: true });
  }
});

test("on a narrow screen the floating composer docks full width and stays out of the tab strip", async ({ page }) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-floating-narrow-")));
  const { terminalHost } = await import("../helpers/terminal-host.ts");
  const { host } = terminalHost(root);
  const bridge = await startBridge(host, fileURLToPath(new URL("../../web/dist/", import.meta.url)));
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await page.addInitScript(() => { localStorage.setItem("pi-web-locale", "en"); localStorage.setItem("pi-web-theme", "dark"); });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(bridge.url);
    await page.getByRole("button", { name: "Open right sidebar" }).click();
    const panel = page.locator("[data-sidebar-right-session]");
    await expect(panel).toHaveAttribute("data-sidebar-right-panel", "fullscreen");
    const floating = page.locator("[data-floating-composer]");
    await expect(floating).toHaveAttribute("data-narrow", "true");
    await expect.poll(async () => Math.round((await floating.boundingBox())!.width)).toBe(390 - 24);
    // The guide tab offers no context chip.
    await expect(floating.locator("[data-floating-context]")).toHaveCount(0);
    await shot(page, "7-narrow-dark");
    await page.getByRole("region", { name: "Ask Pi" }).getByRole("button", { name: "Collapse composer" }).click();
    const icon = page.getByRole("button", { name: /^Ask Pi/ });
    await expect.poll(async () => { const box = (await icon.boundingBox())!; return Math.round(390 - (box.x + box.width)); }).toBe(12);
    // Docked at the bottom, even the icon keeps panel content clear of itself.
    await expect.poll(() => panel.evaluate(element => element.style.getPropertyValue("--pi-floating-composer-inset"))).toBe("56px");
    await page.getByRole("button", { name: /^Ask Pi/ }).click();
    // A short body (landscape phone) falls back to the icon and gives up no content height.
    await page.setViewportSize({ width: 390, height: 320 });
    await expect(floating).toHaveAttribute("data-floating-composer", "collapsed");
    await expect.poll(() => panel.evaluate(element => element.style.getPropertyValue("--pi-floating-composer-inset"))).toBe("");
    await page.setViewportSize({ width: 390, height: 844 });
    // The stored preference (expanded) returns with the height.
    await expect(floating).toHaveAttribute("data-floating-composer", "expanded");
    expect(errors).toEqual([]);
  } finally {
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  }
});
