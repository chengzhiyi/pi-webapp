import { test, expect } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startBridge, type Bridge, type BridgeHost } from "../../extension/bridge.ts";
import { NodeTelemetry } from "../../extension/telemetry.ts";
import type { SessionView } from "../../extension/view.ts";

for (const width of [1440, 1024, 768, 390, 320]) test(`Git panel reviews scoped changes and refreshes read-only diffs at ${width}px`, async ({ page }, testInfo) => {
  test.setTimeout(35000);
  const cwd = await mkdtemp(join(tmpdir(), "pi-git-browser-"));
  const other = await mkdtemp(join(tmpdir(), "pi-git-other-"));
  const git = (...args: string[]) => promisify(execFile)("git", ["-c", "user.name=Git Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd });
  await git("init", "-b", "main");
  await writeFile(join(cwd, "main.ts"), "export const value = 'original';\n");
  await writeFile(join(cwd, "deleted.txt"), "deleted content\n");
  await git("add", "."); await git("commit", "-m", "initial");
  await writeFile(join(cwd, "main.ts"), "export const value = 'staged';\n"); await git("add", "main.ts");
  await writeFile(join(cwd, "main.ts"), "export const value = 'working';\n");
  await rm(join(cwd, "deleted.txt"));
  await writeFile(join(cwd, "新建 文件.txt"), "new content\n<script>unsafe source</script>\n");
  await writeFile(join(cwd, "binary.bin"), Buffer.from([0, 255]));
  let session: SessionView = { schemaVersion: 1, sessionId: "git-a", cwd, name: "Git review", model: "example/model", thinkingLevel: "off",
    thinkingLevels: ["off"], idle: true, contextUsage: null, messages: [], pluginEntries: [] };
  let bridge: Bridge;
  const host: BridgeHost = {
    snapshot: () => session, models: () => [{ provider: "example", id: "model", name: "Example" }], send() {}, abort() {}, async newSession() {}, async setModel() {}, async setThinkingLevel() {},
    config: () => ({ projectTrusted: false, global: { packages: [], extensions: [], skills: [] }, project: { packages: [], extensions: [], skills: [] }, installed: { packages: [], extensions: [], skills: [] } }),
    async updateConfig() { return this.config(); },
    async workspaces() { return { items: [{ id: "a", path: cwd, title: "Git workspace" }, { id: "b", path: other, title: "Other workspace" }], activeId: session.sessionId === "git-a" ? "a" : "b", sessions: [
      { id: "git-a", workspaceId: "a", path: null, name: "Git chat", modified: new Date().toISOString() },
      { id: "git-b", workspaceId: "b", path: null, name: "Other chat", modified: new Date().toISOString() },
    ] }; },
    async addWorkspace() {}, async selectWorkspace(id) { session = { ...session, sessionId: id === "b" ? "git-b" : "git-a", cwd: id === "b" ? other : cwd }; bridge.publish({ type: "snapshot", session }); },
    async newSessionInWorkspace() {}, async removeWorkspace() {}, async selectSession(workspaceId) { await this.selectWorkspace(workspaceId); },
  };
  bridge = await startBridge(host, fileURLToPath(new URL("../../web/dist/", import.meta.url)), new NodeTelemetry({ env: { PI_WEB_SENTRY_ENABLED: "false" }, monitor: false }));
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const gitRequests: string[] = [];
  page.on("request", request => { if (request.url().includes("/api/workspace/git/")) gitRequests.push(request.url()); });
  await page.addInitScript(theme => { localStorage.setItem("pi-web-locale", "en"); localStorage.setItem("pi-web-theme", theme); }, width < 768 ? "dark" : "light");
  await page.setViewportSize({ width, height: 900 });
  const rightbar = page.locator("[data-sidebar-right-session]");
  try {
    await page.goto(bridge.url);
    await page.getByRole("button", { name: "Open right sidebar", exact: true }).click();
    expect(gitRequests).toEqual([]);
    await rightbar.getByRole("button", { name: "Git changes", exact: true }).click();
    await expect(rightbar.getByText("main", { exact: true })).toBeVisible();
    await expect(rightbar.getByRole("region", { name: "Staged", exact: true }).getByRole("button", { name: "main.ts, Modified", exact: true })).toBeVisible();
    await expect(rightbar.getByRole("region", { name: "Unstaged", exact: true }).getByRole("button", { name: "main.ts, Modified", exact: true })).toBeVisible();
    await expect(rightbar.getByRole("region", { name: "Untracked", exact: true })).toContainText("新建 文件.txt");
    await page.screenshot({ path: testInfo.outputPath(`git-status-${width}.png`) });
    await rightbar.getByRole("region", { name: "Staged", exact: true }).getByRole("button", { name: "main.ts, Modified", exact: true }).focus();
    await page.keyboard.press("Enter");
    const diff = rightbar.getByRole("region", { name: "File diff", exact: true });
    await expect(diff).toContainText("-export const value = 'original';");
    await expect(diff).toContainText("+export const value = 'staged';");
    await expect(diff).not.toContainText("'working'");
    await expect(rightbar.getByRole("tab")).toHaveCount(1);
    await expect(rightbar.getByRole("region", { name: "Changed files", exact: true })).toBeVisible();
    await expect(diff.locator('[data-kind="add"]')).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath(`git-diff-${width}.png`) });
    await rightbar.getByRole("region", { name: "Unstaged", exact: true }).getByRole("button", { name: "main.ts, Modified", exact: true }).click();
    await expect(diff).toContainText("+export const value = 'working';");
    // Both transitions are observed by the live UI; settling refreshes without a manual click.
    const started = page.waitForResponse(response => response.url().endsWith("/api/workspace/git/diff"));
    session = { ...session, idle: false }; bridge.publish({ type: "snapshot", session }); await started;
    await writeFile(join(cwd, "main.ts"), "export const value = 'agent finished';\n");
    session = { ...session, idle: true }; bridge.publish({ type: "snapshot", session });
    await expect(diff).toContainText("+export const value = 'agent finished';");
    await writeFile(join(cwd, "main.ts"), "export const value = 'manual refresh';\n");
    await rightbar.getByRole("button", { name: "Refresh diff", exact: true }).click();
    await expect(diff).toContainText("+export const value = 'manual refresh';");
    await rightbar.getByRole("button", { name: "新建 文件.txt, Untracked", exact: true }).click();
    await expect(diff).toContainText("+new content");
    await expect(diff).toContainText("<script>unsafe source</script>");
    expect(await page.title()).not.toBe("unsafe source");
    await rightbar.getByRole("button", { name: "binary.bin, Untracked", exact: true }).click();
    await expect(rightbar.getByText("Text diff is unavailable for binary files.", { exact: true })).toBeVisible();
    await rightbar.getByRole("button", { name: "deleted.txt, Deleted", exact: true }).click();
    await expect(diff).toContainText("-deleted content");
    if (width === 1440) {
      await rightbar.getByRole("button", { name: "Fullscreen", exact: true }).click();
      await expect(rightbar).toHaveAttribute("data-sidebar-right-panel", "fullscreen");
      await rightbar.getByRole("button", { name: "Exit fullscreen", exact: true }).click();
      await rightbar.getByRole("button", { name: "Split", exact: true }).click();
      await rightbar.getByRole("button", { name: "Git changes", exact: true }).click();
      await expect(rightbar.getByRole("region", { name: "Staged", exact: true })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("git-split.png") });
      await rightbar.getByRole("button", { name: "Collapse right sidebar", exact: true }).click();
      // Background tabs do not keep polling after collapse.
      await page.waitForTimeout(200);
      const count = gitRequests.length;
      await page.waitForTimeout(5200);
      expect(gitRequests.length).toBe(count);
      await page.getByRole("button", { name: "Other workspace", exact: true }).click();
      await page.getByRole("button", { name: "Other chat", exact: true }).click();
      await page.getByRole("button", { name: "Open right sidebar", exact: true }).click();
      await rightbar.getByRole("button", { name: "Git changes", exact: true }).click();
      await expect(rightbar.getByText("This workspace is not in a Git repository.", { exact: true })).toBeVisible();
      await expect(rightbar.getByRole("region", { name: "Staged", exact: true })).toHaveCount(0);
      await rightbar.getByRole("button", { name: "Collapse right sidebar", exact: true }).click();
      const first = page.getByRole("button", { name: "Git workspace", exact: true });
      if (await first.getAttribute("aria-expanded") !== "true") await first.click();
      await page.getByRole("button", { name: "Git chat", exact: true }).click();
      await page.getByRole("button", { name: "Open right sidebar", exact: true }).click();
      await expect(rightbar.getByRole("region", { name: "Staged", exact: true })).toBeVisible();
      await page.route("**/api/workspace/git/status", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "unavailable", errorCode: "validation_error" }) }));
      await rightbar.getByRole("button", { name: "Refresh Git status", exact: true }).click();
      await expect(rightbar.getByText("Could not read Git.", { exact: false })).toBeVisible();
      await page.unroute("**/api/workspace/git/status");
      await rightbar.getByRole("button", { name: "Retry", exact: true }).click();
      await expect(rightbar.getByText("Could not read Git.", { exact: false })).toHaveCount(0);
      await git("add", "."); await git("commit", "-m", "clean working tree");
      await rightbar.getByRole("button", { name: "Refresh Git status", exact: true }).click();
      await expect(rightbar.getByText("Working tree clean. No uncommitted changes.", { exact: true })).toBeVisible();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  } finally { await bridge.close(); await rm(cwd, { recursive: true, force: true }); await rm(other, { recursive: true, force: true }); }
});
