import { test, expect } from "@playwright/test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startBridge, type Bridge, type BridgeHost } from "../../extension/bridge.ts";
import { NodeTelemetry } from "../../extension/telemetry.ts";
import type { SessionView } from "../../extension/view.ts";

for (const width of [1440, 1024, 768, 390, 320]) test(`workspace files open from the permanent entry, preview and refresh at ${width}px`, async ({ page }, testInfo) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-files-browser-"));
  const other = join(cwd, "second");
  await mkdir(other);
  await mkdir(join(cwd, "src"));
  await writeFile(join(cwd, "src", "main.ts"), "export const message = 'Hello files';\n");
  await writeFile(join(cwd, "README.md"), "# Workspace preview\n\n**Read only** documentation.\n");
  await writeFile(join(cwd, "empty.txt"), "");
  await writeFile(join(cwd, "binary.bin"), Buffer.from([0, 255]));
  await writeFile(join(cwd, "big.txt"), Buffer.alloc(1024 * 1024, 65));
  await writeFile(join(cwd, "page.html"), '<script>document.title="executed"</script>');
  await writeFile(join(cwd, "image.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64"));
  await writeFile(join(other, "other.txt"), "Different workspace");
  let session: SessionView = { schemaVersion: 1, sessionId: "files-a", cwd, name: "Files A", model: "example/model", thinkingLevel: "off",
    thinkingLevels: ["off"], idle: true, contextUsage: null, messages: [], pluginEntries: [] };
  if (width === 1440) {
    await mkdir(join(cwd, "docs"));
    await writeFile(join(cwd, "docs", "协作内核与插件协议设计.md"), "# 中文文件链接预览\n");
    session.messages = [{ id: "file-links", role: "assistant", timestamp: new Date().toISOString(), blocks: [{ kind: "text", text:
      `[《协作内核与插件协议设计》](docs/${encodeURIComponent("协作内核与插件协议设计.md")})\n\n[再次打开](./docs/${encodeURIComponent("协作内核与插件协议设计.md")})\n\n[绝对路径](${cwd}/README.md)\n\n[外部网站](https://example.com/)`,
    }] }];
  }
  let bridge: Bridge;
  const host: BridgeHost = {
    snapshot: () => session, models: () => [{ provider: "example", id: "model", name: "Example" }], send() {}, abort() {}, async newSession() {}, async setModel() {}, async setThinkingLevel() {},
    config: () => ({ projectTrusted: false, global: { packages: [], extensions: [], skills: [] }, project: { packages: [], extensions: [], skills: [] }, installed: { packages: [], extensions: [], skills: [] } }),
    async updateConfig() { return this.config(); },
    async workspaces() { return { items: [{ id: "a", path: cwd, title: "First workspace" }, { id: "b", path: other, title: "Second workspace" }], activeId: session.sessionId === "files-a" ? "a" : "b", sessions: [
      { id: "files-a", workspaceId: "a", path: null, name: "First chat", modified: new Date().toISOString() },
      { id: "files-b", workspaceId: "b", path: null, name: "Second chat", modified: new Date().toISOString() },
    ] }; },
    async addWorkspace() {}, async selectWorkspace(id) { session = { ...session, sessionId: id === "b" ? "files-b" : "files-a", cwd: id === "b" ? other : cwd }; bridge.publish({ type: "snapshot", session }); },
    async newSessionInWorkspace() {}, async removeWorkspace() {}, async selectSession(workspaceId) { await this.selectWorkspace(workspaceId); },
  };
  bridge = await startBridge(host, fileURLToPath(new URL("../../web/dist/", import.meta.url)), new NodeTelemetry({ env: { PI_WEB_SENTRY_ENABLED: "false" }, monitor: false }));
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript((theme) => { localStorage.setItem("pi-web-locale", "en"); localStorage.setItem("pi-web-theme", theme); }, width < 768 ? "dark" : "light");
  await page.setViewportSize({ width, height: 900 });
  const rightbar = page.locator("[data-sidebar-right-session]");
  const tree = page.getByRole("tree", { name: "Workspace files" });
  const openTree = async () => {
    await rightbar.getByRole("button", { name: "New tab", exact: true }).click();
    await rightbar.getByRole("button", { name: "Workspace files", exact: true }).click();
  };
  try {
    await page.goto(bridge.url);
    if (width === 1440) {
      const popups: string[] = [];
      page.on("popup", popup => popups.push(popup.url()));
      const link = page.getByRole("link", { name: "《协作内核与插件协议设计》", exact: true });
      await link.click();
      await expect(rightbar.getByRole("heading", { name: "中文文件链接预览", exact: true })).toBeVisible();
      expect(popups).toEqual([]);
      await page.getByRole("link", { name: "再次打开", exact: true }).click();
      await expect(rightbar.getByRole("tab", { name: /协作内核与插件协议设计/ })).toHaveCount(1);
      await page.getByRole("link", { name: "绝对路径", exact: true }).click();
      await expect(rightbar.getByRole("heading", { name: "Workspace preview", exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: "外部网站", exact: true })).toHaveAttribute("target", "_blank");
      await expect(page).toHaveURL(new URL(bridge.url).origin + "/");
      await rightbar.getByRole("button", { name: "Collapse right sidebar", exact: true }).click();
    }
    await page.getByRole("button", { name: "Open right sidebar", exact: true }).click();
    if (width === 1440) await rightbar.getByRole("button", { name: "New tab", exact: true }).click();
    await rightbar.getByRole("button", { name: "Workspace files", exact: true }).click();
    await tree.getByRole("treeitem", { name: "src", exact: true }).click();
    const main = tree.getByRole("treeitem", { name: "main.ts", exact: true });
    await main.focus(); await main.press("ArrowLeft");
    const src = tree.getByRole("treeitem", { name: "src", exact: true });
    await expect(src).toBeFocused();
    await src.press("ArrowLeft"); await expect(src).toHaveAttribute("aria-expanded", "false");
    await src.press("ArrowRight"); await expect(main).toBeVisible();
    await main.focus(); await main.press("Enter");
    await expect(rightbar.locator("pre:visible")).toContainText("Hello files");
    await expect(rightbar.getByText("Read only", { exact: true }).filter({ visible: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`code-${width}.png`) });
    await writeFile(join(cwd, "src", "main.ts"), "export const message = 'Updated files';\n");
    await rightbar.getByRole("button", { name: "Reload file", exact: true }).click();
    await expect(rightbar.locator("pre:visible")).toContainText("Updated files");
    await openTree();
    await expect(tree.getByRole("treeitem", { name: "main.ts", exact: true })).toBeVisible();
    await tree.getByRole("treeitem", { name: "README.md", exact: true }).click();
    await expect(rightbar.getByRole("heading", { name: "Workspace preview", exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`markdown-${width}.png`) });
    await rightbar.getByRole("button", { name: "Source", exact: true }).click();
    await expect(rightbar.locator("pre:visible")).toContainText("# Workspace preview");
    await openTree(); await tree.getByRole("treeitem", { name: "image.png", exact: true }).click();
    await expect(rightbar.getByRole("img", { name: "image.png", exact: true })).toBeVisible();
    await rightbar.getByRole("button", { name: "Enlarge image", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Image preview", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Close image preview", exact: true }).click();
    for (const [file, message] of [["empty.txt", "Empty file"], ["binary.bin", "Preview is unavailable for this file type."], ["big.txt", "File is too large"]]) {
      await openTree(); await tree.getByRole("treeitem", { name: file, exact: true }).click();
      await expect(rightbar.getByText(message, { exact: false })).toBeVisible();
    }
    await openTree(); await tree.getByRole("treeitem", { name: "page.html", exact: true }).click();
    await expect(rightbar.locator("pre:visible")).toContainText("<script>");
    expect(await page.title()).not.toBe("executed");
    await openTree();
    await writeFile(join(cwd, "new.txt"), "new");
    await rightbar.getByRole("button", { name: "Reload files", exact: true }).click();
    await expect(tree.getByRole("treeitem", { name: "new.txt", exact: true })).toBeVisible();
    await rm(join(cwd, "new.txt"));
    await tree.getByRole("treeitem", { name: "new.txt", exact: true }).click();
    await expect(rightbar.getByText("Could not read this file.", { exact: false })).toBeVisible();
    await writeFile(join(cwd, "new.txt"), "Restored file");
    await rightbar.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(rightbar.locator("pre:visible")).toContainText("Restored file");
    await openTree();
    await page.screenshot({ path: testInfo.outputPath(`files-${width}.png`) });
    await rightbar.getByRole("button", { name: "Collapse right sidebar", exact: true }).click();
    await page.getByRole("button", { name: "Open right sidebar", exact: true }).click();
    await expect(tree.getByRole("treeitem", { name: "new.txt", exact: true })).toBeVisible();
    if (width === 1440) {
      await rightbar.getByRole("button", { name: "Collapse right sidebar", exact: true }).click();
      await page.getByRole("treeitem", { name: "Second workspace", exact: true }).click();
      await page.getByRole("treeitem", { name: "Second chat", exact: true }).click();
      await page.getByRole("button", { name: "Open right sidebar", exact: true }).click();
      await rightbar.getByRole("button", { name: "Workspace files", exact: true }).click();
      await expect(tree.getByRole("treeitem", { name: "other.txt", exact: true })).toBeVisible();
      await expect(tree.getByRole("treeitem", { name: "main.ts", exact: true })).toHaveCount(0);
      await rightbar.getByRole("button", { name: "Collapse right sidebar", exact: true }).click();
      const firstWorkspace = page.getByRole("treeitem", { name: "First workspace", exact: true });
      if (await firstWorkspace.getAttribute("aria-expanded") !== "true") await firstWorkspace.click();
      await page.getByRole("treeitem", { name: "First chat", exact: true }).click();
      await page.getByRole("button", { name: "Open right sidebar", exact: true }).click();
      await expect(tree.getByRole("treeitem", { name: "main.ts", exact: true })).toBeVisible();
      await rightbar.getByRole("button", { name: "Fullscreen", exact: true }).click();
      await expect(rightbar).toHaveAttribute("data-sidebar-right-panel", "fullscreen");
      await rightbar.getByRole("button", { name: "Exit fullscreen", exact: true }).click();
      await expect(rightbar).toHaveAttribute("data-sidebar-right-panel", "push");
      await rightbar.getByRole("button", { name: "Split", exact: true }).click();
      await rightbar.getByRole("button", { name: "Workspace files", exact: true }).click();
      await expect(tree).toHaveCount(2);
      await page.screenshot({ path: testInfo.outputPath("files-split.png") });
    }
    for (let index = 0; index < 12; index++) {
      const close = rightbar.getByRole("button", { name: "Close", exact: true });
      if (!await close.count()) break;
      // Inactive tab close controls become interactive on hover or keyboard focus.
      await close.first().focus();
      await close.first().click();
    }
    await page.getByRole("button", { name: "Open right sidebar", exact: true }).click();
    await expect(rightbar.getByRole("heading", { name: "Workspace tools", exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await bridge.close(); await rm(cwd, { recursive: true, force: true }); }
});
