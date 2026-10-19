import { test, expect, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { startBridge, type Bridge, type BridgeHost } from "../../extension/bridge.ts";
import type { SessionView } from "../../extension/view.ts";

async function fixture(page: Page, showcase = false) {
  let bridge: Bridge;
  let sequence = 0;
  let activeId = "a";
  let current = "a1";
  let removed = 0;
  const sent: { sessionId: string; text: string }[] = [];
  const items = [{ id: "a", path: "/a", title: "Workspace A" }, { id: "b", path: "/b", title: "Workspace B" }];
  const sessions = [{ id: "a1", workspaceId: "a", path: null, name: "Chat A", modified: "2026-01-01", idle: true },
    { id: "b1", workspaceId: "b", path: null, name: "Chat B", modified: "2026-01-01", idle: true }];
  if (showcase) sessions.push(
    { id: "a2", workspaceId: "a", path: null, name: "Review sidebar interactions", modified: new Date(Date.now() - 5 * 60_000).toISOString(), idle: true },
    { id: "a3", workspaceId: "a", path: null, name: "Ongoing analysis", modified: new Date(Date.now() - 60_000).toISOString(), idle: false },
    { id: "a4", workspaceId: "a", path: null, name: "A long conversation title that should keep its trailing time readable", modified: new Date(Date.now() - 2 * 3_600_000).toISOString(), idle: true },
  );
  const listing = () => ({ items, sessions, activeId });
  const snapshot = (): SessionView => ({ schemaVersion: 1, sessionId: current, cwd: `/${activeId}`, name: sessions.find(s => s.id === current)!.name,
    model: "example/model", thinkingLevel: "off", thinkingLevels: ["off"], idle: true, contextUsage: null, messages: [], pluginEntries: [] });
  const publish = () => { bridge.publish({ type: "snapshot", session: snapshot() }); bridge.publish({ type: "workspaces", value: listing() }); };
  const host: BridgeHost = {
    snapshot, models: () => [{ provider: "example", id: "model", name: "Model" }], commands: () => [], send(sessionId, text) { sent.push({ sessionId, text }); }, abort() {},
    async newSession() { await this.newSessionInWorkspace(activeId); },
    async newSessionInWorkspace(id) {
      activeId = id; current = `new-${++sequence}`;
      sessions.push({ id: current, workspaceId: id, path: null, name: `New chat ${sequence}`, modified: "2026-01-02", idle: true }); publish();
    },
    async selectSession(workspaceId, id) { activeId = workspaceId; current = id; publish(); },
    async setModel() {}, async setThinkingLevel() {},
    config: () => ({ projectTrusted: true, global: { packages: [], extensions: [], skills: [] }, project: { packages: [], extensions: [], skills: [] }, installed: { packages: [], extensions: [], skills: [] } }),
    async updateConfig() { return this.config(); }, async workspaces() { return listing(); },
    async addWorkspace() {}, async selectWorkspace() {},
    async removeWorkspace(id) { removed++; items.splice(items.findIndex(item => item.id === id), 1); publish(); },
  };
  bridge = await startBridge(host, fileURLToPath(new URL("../../web/dist/", import.meta.url)));
  await page.goto(bridge.url);
  await expect(page.getByRole("textbox")).toBeEnabled();
  return { bridge, sent, removed: () => removed };
}

const workspace = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const toggle = (page: Page) => page.locator("[data-sidebar-toggle]");
const actions = (page: Page, title: string) => page.getByRole("button", { name: new RegExp(`^(?:${title} 的工作区操作|Workspace actions for ${title})$`) });
async function requestRemove(page: Page, title: string) {
  await actions(page, title).click();
  await page.getByRole("menuitem", { name: /从列表移除工作区|Remove workspace from list/ }).click();
}

test("search empty state, visible focus, disclosure semantics and safe workspace removal", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const f = await fixture(page);
  try {
    const searchButton = page.getByRole("button", { name: /搜索工作区和会话|Search workspaces and sessions/ });
    await searchButton.click();
    const search = page.getByRole("searchbox", { name: /按名称或工作区路径搜索|Search by name or workspace path/ });
    await search.fill("missing-name");
    await expect(page.getByRole("status").filter({ hasText: /没有找到|No matching/ })).toBeVisible();
    await search.press("Escape");
    await expect(searchButton).toBeFocused();
    await expect(searchButton).toHaveAttribute("aria-expanded", "false");
    await expect(workspace(page, "Workspace A")).toHaveAttribute("aria-expanded", "true");
    await workspace(page, "Chat A").focus();
    await page.keyboard.press("Tab");
    await expect(workspace(page, "Workspace B")).toBeFocused();
    await expect(workspace(page, "Chat A")).toHaveAttribute("title", "Chat A");
    await expect(workspace(page, "Chat A")).toHaveAccessibleDescription(/空闲|Idle/);
    await page.screenshot({ path: testInfo.outputPath("sidebar-desktop.png"), animations: "disabled" });
    await workspace(page, "Workspace B").hover();
    await requestRemove(page, "Workspace B");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText(/不删除目录、文件或会话历史|not deleted/);
    await dialog.getByRole("button", { name: /^(取消|Cancel)$/ }).click();
    expect(f.removed()).toBe(0);
    await requestRemove(page, "Workspace B");
    await dialog.getByRole("button", { name: /^(从列表移除|Remove from list)$/ }).click();
    await expect(workspace(page, "Workspace B")).toHaveCount(0);
    expect(f.removed()).toBe(1);
  } finally { await f.bridge.close(); }
});

for (const theme of ["light", "dark"] as const) {
  test(`DSH sidebar visual contract in ${theme} theme`, async ({ page }, testInfo) => {
    await page.addInitScript(theme => localStorage.setItem("pi-web-theme", theme), theme);
    await page.setViewportSize({ width: 1440, height: 900 });
    const f = await fixture(page, true);
    try {
      await page.getByRole("textbox").focus();
      await page.mouse.move(600, 200);
      const group = workspace(page, "Workspace A").locator("..");
      const current = workspace(page, "Chat A");
      await expect(current).toHaveCSS("height", "32px");
      await expect(current).toHaveCSS("border-radius", "12px");
      await expect(current).toHaveCSS("box-shadow", "none");
      await expect(workspace(page, "Workspace A")).toHaveCSS("height", "34px");
      expect((await current.boundingBox())!.width).toBeCloseTo((await workspace(page, "Workspace A").boundingBox())!.width, 0);
      expect(await workspace(page, "Workspace A").evaluate(node => getComputedStyle(node).color)).toBe(await current.evaluate(node => getComputedStyle(node).color));
      await expect(group.locator('[data-workspace-leading="folder"]')).toBeVisible();
      await expect(group.locator('[data-workspace-leading="chevron"]')).toBeHidden();
      await expect(group.locator('[data-workspace-actions]')).toHaveCSS("opacity", "0");
      await expect(current.locator('[data-state]')).toHaveCount(0);
      await expect(workspace(page, "Ongoing analysis").locator('[data-state="ongoing"]')).toBeVisible();
      await expect(workspace(page, "Review sidebar interactions").locator("time")).toHaveText("5min");
      await expect(current.locator("time")).toHaveCSS("font-size", "10px");
      await page.screenshot({ path: testInfo.outputPath(`dsh-sidebar-${theme}.png`), clip: { x: 0, y: 0, width: 280, height: 900 }, animations: "disabled" });
      await workspace(page, "Workspace A").hover();
      await expect(group.locator('[data-workspace-leading="folder"]')).toBeHidden();
      await expect(group.locator('[data-workspace-leading="chevron"]')).toBeVisible();
      await expect(group.locator('[data-workspace-actions]')).toHaveCSS("opacity", "1");
      await expect(group.locator('[data-workspace-actions]')).toHaveCSS("gap", "12px");
      await actions(page, "Workspace A").click();
      await expect(page.getByRole("menuitem")).toBeDisabled();
      await page.keyboard.press("Escape");
      await expect(actions(page, "Workspace A")).toBeFocused();
      await actions(page, "Workspace B").focus();
      await page.keyboard.press("ArrowDown");
      await expect(page.getByRole("menuitem")).toBeFocused();
      await page.screenshot({ path: testInfo.outputPath(`dsh-menu-${theme}.png`), clip: { x: 0, y: 0, width: 340, height: 450 }, animations: "disabled" });
      await page.keyboard.press("Escape");
      await expect(actions(page, "Workspace B")).toBeFocused();
      expect(f.removed()).toBe(0);
    } finally { await f.bridge.close(); }
  });
}

test("new sessions reveal a collapsed active group and clear filters without losing drafts", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const f = await fixture(page);
  try {
    await page.getByRole("textbox").fill("Keep this draft");
    await workspace(page, "Workspace A").click();
    await expect(workspace(page, "Workspace A")).toHaveAttribute("aria-expanded", "false");
    await page.getByRole("button", { name: /在 Workspace A 新建会话|Create a session in Workspace A/ }).click();
    await expect(workspace(page, "New chat 1")).toHaveAttribute("aria-current", "page");
    await expect(workspace(page, "Workspace A")).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("textbox")).toBeEmpty();
    await workspace(page, "Chat A").click();
    await expect(page.getByRole("textbox")).toHaveText("Keep this draft");
    await page.getByRole("button", { name: /搜索工作区和会话|Search workspaces and sessions/ }).click();
    await page.getByRole("searchbox").fill("Chat A");
    await page.getByRole("button", { name: /在 Workspace A 新建会话|Create a session in Workspace A/ }).click();
    await expect(page.getByRole("searchbox")).toHaveValue("");
    await expect(workspace(page, "New chat 2")).toHaveAttribute("aria-current", "page");
  } finally { await f.bridge.close(); }
});

test("pending navigation disables duplicate entry points and failures leave navigation usable", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const f = await fixture(page);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/session/select", async route => {
    await gate;
    await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "Switch failed", errorCode: "validation_error" }) });
  });
  try {
    await workspace(page, "Workspace B").click();
    await workspace(page, "Chat B").click();
    await expect(page.getByRole("status").filter({ hasText: /正在处理|Working/ })).toBeVisible();
    const globalNew = page.getByRole("button", { name: /^(新会话|New session)$/ });
    for (const button of await globalNew.all()) await expect(button).toBeDisabled();
    release();
    await expect(page.getByRole("alert").filter({ hasText: "Switch failed" })).toBeVisible();
    await expect(workspace(page, "Chat A")).toHaveAttribute("aria-current", "page");
    for (const button of await globalNew.all()) await expect(button).toBeEnabled();
  } finally { release(); await f.bridge.close(); }
});

test("drafts and uploads stay with their originating session, including late upload completion", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const f = await fixture(page);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let uploadStarted!: () => void;
  const started = new Promise<void>(resolve => { uploadStarted = resolve; });
  const removed: unknown[] = [];
  await page.route("**/api/attachment?*", async route => {
    uploadStarted(); await gate;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ id: "receipt-a", name: "note.txt", bytes: 4 }) });
  });
  await page.route("**/api/attachment/remove", async route => { removed.push(route.request().postDataJSON()); await route.fulfill({ body: "{}" }); });
  try {
    await page.getByRole("textbox").fill("Draft A");
    await page.locator('input[type="file"]').setInputFiles({ name: "note.txt", mimeType: "text/plain", buffer: Buffer.from("test") });
    await started;
    await workspace(page, "Workspace B").click();
    await workspace(page, "Chat B").click();
    release();
    await expect(page.getByRole("textbox")).toBeEmpty();
    await expect(page.getByRole("group", { name: /待发送附件|Pending attachments/ })).toHaveCount(0);
    await page.getByRole("textbox").fill("Draft B");
    await workspace(page, "Chat A").click();
    await expect(page.getByRole("textbox")).toHaveText("Draft A");
    await expect(page.getByRole("group", { name: /待发送附件|Pending attachments/ })).toContainText("note.txt");
    await expect(page.getByRole("button", { name: /^(发送消息|Send message)$/ })).toBeEnabled();
    expect(removed).toEqual([]);
    await workspace(page, "Chat B").click();
    await expect(page.getByRole("textbox")).toHaveText("Draft B");
    await expect(page.getByRole("group", { name: /待发送附件|Pending attachments/ })).toHaveCount(0);
  } finally { release(); await f.bridge.close(); }
});

test("ready attachments obtain fresh real bridge receipts after switching away and back", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const f = await fixture(page);
  const receipts: string[] = [];
  page.on("response", async response => {
    if (new URL(response.url()).pathname === "/api/attachment" && response.ok()) receipts.push((await response.json()).id);
  });
  try {
    await page.getByRole("textbox").fill("Use my note");
    await page.locator('input[type="file"]').setInputFiles({ name: "note.txt", mimeType: "text/plain", buffer: Buffer.from("test") });
    const send = page.getByRole("button", { name: /^(发送消息|Send message)$/ });
    await expect(send).toBeEnabled();
    await workspace(page, "Workspace B").click();
    await workspace(page, "Chat B").click();
    await workspace(page, "Chat A").click();
    await expect(send).toBeEnabled();
    await expect.poll(() => receipts.length).toBe(2);
    expect(receipts[1]).not.toBe(receipts[0]);
    await send.click();
    await expect.poll(() => f.sent.length).toBe(1);
    expect(f.sent[0].sessionId).toBe("a1");
    expect(f.sent[0].text).toContain("Use my note");
    await expect(page.getByRole("textbox")).toBeEmpty();
  } finally { await f.bridge.close(); }
});

test.describe("touch layouts", () => {
  test.use({ hasTouch: true });
for (const width of [320, 390, 768]) {
  test(`mobile drawer preserves content width, traps focus and closes on selection at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    const f = await fixture(page);
    try {
      const before = await page.getByRole("textbox").boundingBox();
      await toggle(page).click();
      const dialog = page.getByRole("dialog", { name: /对话管理|Conversation navigation/ });
      await expect(dialog).toBeVisible();
      if (width === 390) await page.screenshot({ path: testInfo.outputPath("sidebar-mobile.png"), animations: "disabled" });
      const during = await page.getByRole("textbox", { includeHidden: true }).boundingBox();
      expect(during!.width).toBeCloseTo(before!.width, 0);
      await actions(page, "Workspace A").click();
      await expect(page.getByRole("menuitem")).toBeDisabled();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("menu")).toHaveCount(0);
      await expect(dialog).toBeVisible();
      await expect(actions(page, "Workspace A")).toBeFocused();
      const focusable = dialog.locator('button:visible:not([disabled])');
      await focusable.last().focus();
      await page.keyboard.press("Tab");
      await expect(focusable.first()).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(toggle(page)).toBeFocused();
      await toggle(page).click();
      await page.getByRole("button", { name: /^(关闭侧栏|Close sidebar)$/ }).click({ position: { x: width - 10, y: 400 } });
      await expect(dialog).toHaveCount(0);
      await toggle(page).click();
      await dialog.getByRole("button", { name: "Workspace B", exact: true }).click();
      await dialog.getByRole("button", { name: "Chat B", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByRole("textbox")).toBeEnabled();
      await page.getByRole("textbox").fill("Mobile draft");
      await toggle(page).click();
      await dialog.getByRole("button", { name: /在 Workspace B 新建会话|Create a session in Workspace B/ }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByRole("textbox")).toBeEmpty();
    } finally { await f.bridge.close(); }
  });
}
});
