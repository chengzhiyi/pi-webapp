import { test, expect } from "@playwright/test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { WorkspaceSessions } from "../../extension/workspace-sessions.ts";
import { startBridge, type Bridge, type BridgeHost } from "../../extension/bridge.ts";
import { controlledReply } from "../helpers/controlled-reply.ts";

test("switching running chats restores their own streams and keeps background work alive", async ({ page }, testInfo) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-background-browser-")));
  const savedAgent = process.env.PI_CODING_AGENT_DIR;
  const savedPlugins = process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS = "";
  const first = join(root, "first"); const second = join(root, "second");
  await mkdir(first); await mkdir(second);
  let bridge: Bridge | undefined;
  const items = [{ id: "first", path: first, title: "First workspace" }, { id: "second", path: second, title: "Second workspace" }];
  const listing = () => ({ items, activeId: items.find(item => item.path === sessions.path)?.id ?? null,
    sessions: sessions.retainedSessions().map(session => ({ id: session.sessionId, workspaceId: items.find(item => item.path === session.cwd)!.id, path: session.path, name: session.name, modified: session.modified, idle: session.idle })) });
  const sessions = new WorkspaceSessions(event => bridge?.publish(event), () => undefined, () => false, () => undefined, undefined,
    () => bridge?.publish({ type: "workspaces", value: listing() }));
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await sessions.open(first, "new");
    const a = sessions.session!; a.setSessionName("First chat");
    const aReply = await controlledReply(a, "First workspace progress");
    await sessions.send("Work in A"); await aReply.ready;
    await sessions.open(second, "new");
    const b = sessions.session!; b.setSessionName("Second chat");
    const bReply = await controlledReply(b, "Second workspace progress");
    await sessions.open(first, "continue");
    const host: BridgeHost = {
      snapshot: () => sessions.snapshot(), models: () => [{ provider: a.model!.provider, id: a.model!.id, name: a.model!.name }], commands: () => [],
      send: (_id, text, images, correlation) => sessions.send(text, images, correlation), abort: () => sessions.stop(),
      async newSession() { await sessions.open(sessions.path!, "new"); },
      setModel: (_id, provider, id) => sessions.setModel(provider, id), async setThinkingLevel() {},
      config: () => ({ projectTrusted: false, global: { packages: [], extensions: [], skills: [] }, project: { packages: [], extensions: [], skills: [] }, installed: { packages: [], extensions: [], skills: [] } }),
      async updateConfig() { return this.config(); }, async workspaces() { return listing(); },
      async addWorkspace() {}, async removeWorkspace() {},
      async selectWorkspace(id) { await sessions.open(items.find(item => item.id === id)!.path, "continue"); },
      async newSessionInWorkspace(id) { await sessions.open(items.find(item => item.id === id)!.path, "new"); },
      async selectSession(workspaceId, id) { await sessions.open(items.find(item => item.id === workspaceId)!.path, { sessionId: id }); },
    };
    bridge = await startBridge(host, fileURLToPath(new URL("../../web/dist/", import.meta.url)));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(bridge.url);
    await expect(page.getByText("First workspace progress", { exact: true })).toBeVisible();
    await page.getByRole("textbox").fill("Unsent draft in A");
    await page.getByRole("button", { name: "Second workspace", exact: true }).click();
    await page.getByRole("button", { name: "Second chat", exact: true }).click();
    await expect(page.getByRole("textbox")).toHaveText("");
    await expect(page.getByText("First workspace progress", { exact: true })).toHaveCount(0);
    expect(a.isIdle).toBe(false);
    await page.getByRole("textbox").fill("Work in B");
    await page.getByRole("textbox").press("Enter");
    await bReply.ready;
    await expect(page.getByText("Second workspace progress", { exact: true })).toBeVisible();

    await page.getByRole("textbox").fill("Unsent draft in B");
    await page.getByRole("button", { name: "First chat", exact: true }).click();
    await expect(page.getByRole("textbox")).toHaveText("Unsent draft in A");
    await expect(page.getByText("First workspace progress", { exact: true })).toBeVisible();
    await expect(page.getByText("Second workspace progress", { exact: true })).toHaveCount(0);
    expect(b.isIdle).toBe(false);
    await expect(page.getByRole("button", { name: "Second chat", exact: true }).locator('[data-state="ongoing"]')).toHaveCount(1);
    await page.reload();
    await expect(page.getByText("First workspace progress", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: /^(?:在 First workspace 新建会话|Create a session in First workspace)$/ }).click();
    await expect(page.getByText("First workspace progress", { exact: true })).toHaveCount(0);
    expect(a.isIdle).toBe(false);
    expect(b.isIdle).toBe(false);
    const emptyId = sessions.snapshot().sessionId;
    bReply.finish(); await b.waitForIdle();
    expect(sessions.snapshot().sessionId).toBe(emptyId);
    await expect(page.getByText("Second workspace progress", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "First chat", exact: true }).click();
    await expect(page.getByText("First workspace progress", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: /^(?:暂停|Pause|停止|Stop)$/ }).click();
    await expect.poll(() => a.isIdle).toBe(true);
    await page.getByRole("button", { name: "Second workspace", exact: true }).click();
    await expect(page.getByRole("button", { name: "Second chat", exact: true }).locator('[data-state]')).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Second chat", exact: true })).toHaveAccessibleDescription(/空闲|Idle/);
    await page.getByRole("button", { name: "Second chat", exact: true }).click();
    await expect(page.getByText("Second workspace progress", { exact: true })).toBeVisible();
    await expect(page.getByText("First workspace progress", { exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("background-sessions.png") });
    expect(errors).toEqual([]);
  } finally {
    await sessions.dispose(); await bridge?.close();
    if (savedAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedAgent;
    if (savedPlugins === undefined) delete process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS; else process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS = savedPlugins;
    await rm(root, { recursive: true, force: true });
  }
});
