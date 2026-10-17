import { test, expect } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startBridge } from "../../extension/bridge.ts";
import { NodeTelemetry } from "../../extension/telemetry.ts";
import { terminalHost } from "../helpers/terminal-host.ts";

for (const width of [1440, 768, 390, 320]) test(`Git staging, commits and branch management at ${width}px`, async ({ page }, testInfo) => {
  test.setTimeout(60000);
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "pi-git-write-browser-")));
  const git = async (...args: string[]) => (await promisify(execFile)("git", args, { cwd })).stdout.trim();
  await git("init", "-b", "main"); await git("config", "user.name", "Browser Test"); await git("config", "user.email", "test@example.invalid"); await git("config", "commit.gpgsign", "false");
  await writeFile(join(cwd, "main.txt"), "original\n"); await git("add", "."); await git("commit", "-m", "initial");
  await writeFile(join(cwd, "main.txt"), "staged\n");
  const { host, switchSession } = terminalHost(cwd); let busy: string[] = []; host.busyGitWorkspaces = () => busy;
  const bridge = await startBridge(host, fileURLToPath(new URL("../../web/dist/", import.meta.url)), new NodeTelemetry({ env: { PI_WEB_SENTRY_ENABLED: "false" }, monitor: false }));
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const writes: string[] = []; page.on("request", request => { if (request.url().endsWith("/api/workspace/git/write")) writes.push(request.postData()!); });
  await page.addInitScript(theme => { localStorage.setItem("pi-web-locale", "en"); localStorage.setItem("pi-web-theme", theme); }, width < 768 ? "dark" : "light");
  await page.setViewportSize({ width, height: 900 });
  const panel = page.locator("[data-sidebar-right-session]");
  const refresh = async () => { await panel.getByRole("button", { name: "Refresh Git status", exact: true }).click(); };
  const stage = () => panel.getByRole("button", { name: "Stage main.txt", exact: true });
  const message = panel.getByRole("textbox", { name: "Commit message", exact: true });
  const commit = panel.getByRole("button", { name: "Commit", exact: true });
  const openBranches = async () => { await panel.getByRole("button", { name: "Manage branches", exact: true }).click(); await expect(panel.getByRole("dialog", { name: "Manage branches", exact: true })).toBeVisible(); };
  const newBranch = async () => { await openBranches(); await panel.getByRole("dialog").getByRole("button", { name: "New branch", exact: true }).click(); };
  const tab = () => panel.getByRole("tab").filter({ hasText: /^Git$/ });
  try {
    await page.goto(bridge.url); await page.getByRole("button", { name: "Open right sidebar", exact: true }).click(); await panel.getByRole("button", { name: "Git changes", exact: true }).click();
    await expect(commit).toBeDisabled(); await expect(stage()).toBeEnabled();
    busy = [join(cwd, "app")]; await refresh(); await expect(stage()).toBeDisabled();
    await expect(panel.getByText("A chat sharing this working tree is running.", { exact: false })).toBeVisible(); busy = []; await refresh();
    await expect(stage()).toBeEnabled(); await stage().focus(); await stage().press("Enter");
    await expect(panel.getByRole("button", { name: "Unstage main.txt", exact: true })).toBeEnabled();
    await expect(panel.getByRole("region", { name: "Staged", exact: true })).toContainText("main.txt");
    await panel.getByRole("button", { name: "Unstage main.txt", exact: true }).click(); await expect(stage()).toBeEnabled(); expect(await git("diff", "--cached")).toBe("");
    await stage().click(); await expect(panel.getByRole("button", { name: "Unstage main.txt", exact: true })).toBeEnabled();
    await message.fill("Staged from Git panel\n\nCommit body <script>literal</script>");
    if (width === 1440) {
      const before = writes.length;
      await message.dispatchEvent("compositionstart", { data: "提" });
      await message.dispatchEvent("keydown", { key: "Enter", ctrlKey: true, isComposing: false });
      await message.dispatchEvent("compositionend", { data: "提" });
      await message.dispatchEvent("keydown", { key: "Enter", ctrlKey: true, isComposing: false });
      await message.dispatchEvent("keyup", { key: "Enter" });
      expect(writes.length).toBe(before);
    }
    await page.screenshot({ path: testInfo.outputPath(`git-write-${width}.png`) });
    // Old expected states are rejected, while the commit draft survives.
    await writeFile(join(cwd, "main.txt"), "working\n"); await commit.click();
    await expect(panel.getByText("Repository changed.", { exact: false })).toBeVisible(); await expect(message).toHaveValue(/Staged from Git panel/);
    await expect(commit).toBeEnabled(); await commit.click(); await expect(panel.getByText("Commit created.", { exact: true })).toBeVisible(); await expect(message).toHaveValue("");
    expect(await git("show", "HEAD:main.txt")).toBe("staged"); expect(await readFile(join(cwd, "main.txt"), "utf8")).toBe("working\n");
    await newBranch();
    const create = panel.getByRole("form", { name: "Create branch", exact: true });
    const branch = create.getByRole("textbox", { name: "New branch name", exact: true });
    const checkout = create.getByRole("checkbox", { name: "Switch after creating", exact: true });
    await branch.fill("feature/panel"); await expect(create.getByRole("button", { name: "Create branch", exact: true })).toBeDisabled();
    await checkout.uncheck(); await create.getByRole("button", { name: "Create branch", exact: true }).click(); await expect(panel.getByText("Branch created.", { exact: true })).toBeVisible();
    expect(await git("branch", "--show-current")).toBe("main");
    await expect(stage()).toBeEnabled(); await stage().click(); await message.fill("Finish working content"); await expect(commit).toBeEnabled(); await message.press("Control+Enter"); await expect(panel.getByText("Working tree clean. No uncommitted changes.", { exact: true })).toBeVisible();
    await openBranches();
    const choose = panel.getByRole("button", { name: "Switch to branch: feature/panel", exact: true });
    await expect(choose).toBeEnabled(); await choose.click(); await expect(panel.getByText("Branch switched.", { exact: true })).toBeVisible();
    expect(await git("branch", "--show-current")).toBe("feature/panel");
    await newBranch(); await branch.fill("feature/next"); await checkout.check(); await expect(create.getByRole("button", { name: "Create branch", exact: true })).toBeEnabled(); await create.getByRole("button", { name: "Create branch", exact: true }).click(); await expect(panel.getByText("Branch created.", { exact: true })).toBeVisible();
    expect(await git("branch", "--show-current")).toBe("feature/next");
    await newBranch(); await branch.fill("main"); await expect(create.getByRole("button", { name: "Create branch", exact: true })).toBeEnabled(); await create.getByRole("button", { name: "Create branch", exact: true }).click(); await expect(panel.getByText("A branch with this name already exists.", { exact: true })).toBeVisible(); await expect(branch).toHaveValue("main");
    await page.screenshot({ path: testInfo.outputPath(`git-branches-${width}.png`) });
    await page.keyboard.press("Escape");
    if (width === 1440) {
      // Chat-owned drafts survive a round trip, including checkbox state.
      await message.fill("Retained draft"); await newBranch(); await branch.fill("feature/draft"); await checkout.uncheck();
      bridge.publish({ type: "snapshot", session: switchSession("other-chat") });
      await page.getByRole("button", { name: "Open right sidebar", exact: true }).click(); await panel.getByRole("button", { name: "Git changes", exact: true }).click();
      await expect(message).toHaveValue("");
      bridge.publish({ type: "snapshot", session: switchSession("terminal-a") }); await expect(message).toHaveValue("Retained draft");
      await newBranch(); await expect(branch).toHaveValue("feature/draft"); await expect(checkout).not.toBeChecked(); await page.keyboard.press("Escape");
      // The server commits, but a lost response must not clear the draft or retry automatically.
      await writeFile(join(cwd, "main.txt"), "unknown outcome\n"); await refresh(); await expect(stage()).toBeEnabled(); await stage().click(); await message.fill("Commit with lost response");
      await page.route("**/api/workspace/git/write", async route => { await route.fetch(); await route.abort(); }, { times: 1 });
      const before = writes.length; await expect(commit).toBeEnabled(); await commit.click();
      await expect(panel.getByText("Operation outcome is unknown.", { exact: false })).toBeVisible(); await expect(message).toHaveValue("Commit with lost response");
      await expect(commit).toBeDisabled(); expect(writes.length).toBe(before + 1); expect(await git("log", "-1", "--format=%s")).toBe("Commit with lost response");
      await panel.getByRole("button", { name: "History", exact: true }).click(); await expect(panel.getByRole("list", { name: "Commit history", exact: true })).toContainText("Commit with lost response");
      await tab().click(); await panel.getByRole("button", { name: "Changes", exact: true }).click(); await expect(message).toHaveValue("Commit with lost response");
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true); expect(errors).toEqual([]);
  } finally { await bridge.close(); await rm(cwd, { recursive: true, force: true }); }
});
