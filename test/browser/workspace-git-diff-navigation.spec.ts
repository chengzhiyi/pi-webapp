import { test, expect } from "@playwright/test";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startBridge } from "../../src/host/server/transport/bridge.ts";
import { terminalHost } from "../helpers/terminal-host.ts";

for (const width of [1440, 768, 390, 320]) test(`clean diff and change navigation stay compact at ${width}px`, async ({ page }, testInfo) => {
  test.setTimeout(40000);
  const cwd = await mkdtemp(join(tmpdir(), "pi-diff-nav-"));
  const git = async (...args: string[]) => (await promisify(execFile)("git", args, { cwd })).stdout.trim();
  await git("init", "-b", "main"); await git("config", "user.name", "Diff Test"); await git("config", "user.email", "test@example.invalid"); await git("config", "commit.gpgsign", "false"); await git("config", "core.filemode", "true");
  const original = Array.from({ length: 180 }, (_, index) => `line ${index + 1}`);
  await writeFile(join(cwd, "main.txt"), original.join("\n") + "\n");
  await writeFile(join(cwd, "mode.sh"), "echo mode\n"); await chmod(join(cwd, "mode.sh"), 0o644);
  await git("add", "."); await git("commit", "-m", "Initial");
  const edited = [...original];
  edited[7] = "diff --git literal source"; edited[11] = "+++ literal header"; edited[79] = "index literal source"; edited[139] = "last edit " + "long source ".repeat(100);
  await writeFile(join(cwd, "main.txt"), edited.join("\n") + "\n");
  await git("add", "."); await git("commit", "-m", "Four code changes"); const commit = await git("rev-parse", "HEAD");
  await writeFile(join(cwd, "main.txt"), original.join("\n") + "\n");
  await writeFile(join(cwd, "small.txt"), "one change\n"); await writeFile(join(cwd, "image.bin"), Buffer.from([0, 1, 2])); await chmod(join(cwd, "mode.sh"), 0o755);
  const { host } = terminalHost(cwd); const bridge = await startBridge(host, fileURLToPath(new URL("../../web/dist/", import.meta.url)));
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(theme => { localStorage.setItem("pi-web-locale", "en"); localStorage.setItem("pi-web-theme", theme); }, width < 768 ? "dark" : "light");
  await page.setViewportSize({ width, height: 900 });
  const panel = page.locator("[data-sidebar-right-session]");
  const files = panel.getByRole("region", { name: "Changed files", exact: true });
  const preview = panel.getByRole("region", { name: "Diff preview", exact: true });
  const diff = preview.getByRole("region", { name: "File diff", exact: true });
  const next = preview.getByRole("button", { name: "Next change", exact: true });
  const previous = preview.getByRole("button", { name: "Previous change", exact: true });
  const position = preview.getByRole("status", { name: "Change position", exact: true });
  let release: (() => void) | undefined;
  try {
    await page.goto(bridge.url); await page.getByRole("button", { name: "Open right sidebar", exact: true }).click(); await panel.getByRole("button", { name: "Git changes", exact: true }).click();
    await files.getByRole("button", { name: "main.txt, Modified", exact: true }).click();
    await expect(diff).toContainText("-diff --git literal source"); await expect(diff).toContainText("-+++ literal header");
    await expect(diff).not.toContainText("diff --git a/main.txt"); await expect(diff).not.toContainText("--- a/main.txt"); await expect(diff).not.toContainText("@@ -");
    await expect(position).toHaveText("0/4"); await expect(previous).toBeDisabled(); await expect(next).toBeEnabled();
    await next.click(); await expect(position).toHaveText("1/4"); await expect(previous).toBeDisabled();
    await next.focus(); await page.keyboard.press("Enter"); await expect(position).toHaveText("2/4"); await expect(next).toBeFocused();
    await previous.click(); await expect(position).toHaveText("1/4");
    const listScroll = await files.evaluate(element => element.scrollTop);
    await diff.evaluate(element => { element.scrollLeft = 24; });
    for (let index = 0; index < 3; index++) await next.click();
    await expect(position).toHaveText("4/4"); await expect(next).toBeDisabled();
    await expect(diff.locator('[data-change-start="true"][data-active="true"]')).toBeInViewport();
    expect(await diff.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    expect(await diff.evaluate(element => element.scrollLeft)).toBe(24);
    expect(await files.evaluate(element => element.scrollTop)).toBe(listScroll);
    await expect(files).toBeVisible(); await expect(panel.getByRole("tab")).toHaveCount(1);
    for (const button of [previous, next, preview.getByRole("button", { name: "Close diff preview", exact: true })]) await expect(button).toBeInViewport({ ratio: 1 });
    if (width === 320) {
      await page.setViewportSize({ width, height: 320 }); await expect(next).toBeInViewport({ ratio: 1 }); await expect(preview.getByRole("button", { name: "Close diff preview", exact: true })).toBeInViewport({ ratio: 1 }); await page.setViewportSize({ width, height: 900 });
    }
    await diff.evaluate(element => { element.scrollLeft = 0; });
    await panel.screenshot({ path: testInfo.outputPath(`diff-navigation-${width}.png`) });
    if (width === 1440) {
      await panel.getByRole("button", { name: "Fullscreen", exact: true }).click(); await expect(next).toBeInViewport({ ratio: 1 }); await previous.click(); await expect(position).toHaveText("3/4");
      await panel.screenshot({ path: testInfo.outputPath("diff-navigation-wide.png") });
      await panel.getByRole("button", { name: "Exit fullscreen", exact: true }).click();
    }
    await files.getByRole("button", { name: "small.txt, Untracked", exact: true }).click(); await expect(position).toHaveText("0/1"); await next.click(); await expect(position).toHaveText("1/1"); await expect(next).toBeDisabled(); await expect(previous).toBeDisabled();
    await files.getByRole("button", { name: "mode.sh, Modified", exact: true }).click(); await expect(preview).toContainText("File mode: 100644 → 100755"); await expect(preview).not.toContainText("old mode"); await expect(position).toHaveText("0/0"); await expect(next).toBeDisabled(); await expect(previous).toBeDisabled();
    await files.getByRole("button", { name: "image.bin, Untracked", exact: true }).click(); await expect(preview).toContainText("Text diff is unavailable for binary files."); await expect(next).toBeDisabled();
    await files.getByRole("button", { name: "main.txt, Modified", exact: true }).click(); await expect(position).toHaveText("0/4"); await next.click();
    // Same-file refresh updates targets, clears the previous highlight and resets scrolling.
    const single = [...edited]; single[79] = "refreshed source"; await writeFile(join(cwd, "main.txt"), single.join("\n") + "\n");
    let seen!: () => void; const intercepted = new Promise<void>(yes => { seen = yes; }); const gate = new Promise<void>(yes => { release = yes; });
    await page.route("**/api/workspace/git/diff", async route => { seen(); await gate; await route.continue(); }, { times: 1 });
    await preview.getByRole("button", { name: "Refresh diff", exact: true }).click(); await intercepted; await expect(next).toBeDisabled(); await expect(previous).toBeDisabled(); release?.();
    await expect(position).toHaveText("0/1"); await expect(diff).toContainText("+refreshed source"); await expect(diff.locator('[data-active="true"]')).toHaveCount(0); expect(await diff.evaluate(element => element.scrollTop)).toBe(0);
    await page.route("**/api/workspace/git/diff", route => route.fulfill({ status: 503, json: { error: "unavailable", errorCode: "validation_error" } }), { times: 1 });
    await preview.getByRole("button", { name: "Refresh diff", exact: true }).click(); await expect(preview.getByText("Could not read this diff. Try again.", { exact: false })).toBeVisible(); await expect(next).toBeDisabled();
    await preview.getByRole("button", { name: "Retry", exact: true }).click(); await expect(next).toBeEnabled();
    await panel.getByRole("button", { name: "History", exact: true }).click(); await panel.locator(`[data-commit="${commit}"]`).click(); await panel.getByRole("button", { name: "View commit diff: main.txt", exact: true }).click();
    await expect(position).toHaveText("0/4"); await expect(diff).toContainText("+diff --git literal source"); await expect(diff).toContainText("+index literal source"); await expect(diff.locator('[data-kind="meta"]')).toHaveCount(0);
    await next.click(); await next.click(); await expect(position).toHaveText("2/4"); await expect(panel.getByRole("tab")).toHaveCount(2);
    await expect(panel.getByRole("button", { name: "View commit diff: main.txt", exact: true })).toBeVisible();
    await panel.screenshot({ path: testInfo.outputPath(`commit-navigation-${width}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); expect(errors).toEqual([]);
  } finally { release?.(); await bridge.close(); await rm(cwd, { recursive: true, force: true }); }
});
