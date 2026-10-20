import { test, expect } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startBridge } from "../../src/host/server/transport/bridge.ts";
import { terminalHost } from "../helpers/terminal-host.ts";

for (const width of [1440, 768, 390, 320]) test(`inline Git diff keeps files, selection and writes coherent at ${width}px`, async ({ page }, testInfo) => {
  test.setTimeout(40000);
  const cwd = await mkdtemp(join(tmpdir(), "pi-inline-git-"));
  const other = await mkdtemp(join(tmpdir(), "pi-inline-other-"));
  const git = async (...args: string[]) => (await promisify(execFile)("git", args, { cwd })).stdout;
  await git("init", "-b", "main"); await git("config", "user.name", "Inline Test"); await git("config", "user.email", "test@example.invalid"); await git("config", "commit.gpgsign", "false");
  await writeFile(join(cwd, "main.txt"), "original\n"); await git("add", "."); await git("commit", "-m", "initial");
  await writeFile(join(cwd, "main.txt"), Array.from({ length: 80 }, (_, i) => `working ${i}`).join("\n") + "\n");
  for (const name of ["slow.txt", "fast.txt", "retry.txt"]) await writeFile(join(cwd, name), `${name} content\n`);
  const { host, switchSession } = terminalHost(cwd);
  const bridge = await startBridge(host, fileURLToPath(new URL("../../web/dist/", import.meta.url)));
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(theme => { localStorage.setItem("pi-web-locale", "en"); localStorage.setItem("pi-web-theme", theme); }, width < 768 ? "dark" : "light");
  await page.setViewportSize({ width, height: 900 });
  const panel = page.locator("[data-sidebar-right-session]");
  const files = panel.getByRole("region", { name: "Changed files", exact: true });
  const preview = panel.getByRole("region", { name: "Diff preview", exact: true });
  const diff = preview.getByRole("region", { name: "File diff", exact: true });
  const file = (name: string) => files.getByRole("button", { name, exact: true });
  let release: (() => void) | undefined;
  try {
    await page.goto(bridge.url); await page.getByRole("button", { name: "Open right sidebar", exact: true }).click(); await panel.getByRole("button", { name: "Git changes", exact: true }).click();
    await file("main.txt, Modified").focus(); await page.keyboard.press("Enter");
    await expect(diff).toContainText("+working 0"); await expect(file("main.txt, Modified")).toHaveAttribute("aria-pressed", "true");
    await expect(panel.getByRole("tab")).toHaveCount(1); await expect(files).toBeVisible();
    const listBefore = await files.boundingBox(); const diffBefore = await preview.boundingBox(); expect(diffBefore!.y).toBeGreaterThanOrEqual(listBefore!.y + listBefore!.height - 1);
    await diff.focus(); await diff.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect(file("main.txt, Modified")).toBeInViewport();
    await diff.evaluate(element => { element.scrollTop = 0; }); await file("main.txt, Modified").click();
    await panel.screenshot({ path: testInfo.outputPath(`inline-${width}.png`) });
    if (width === 320) {
      await page.setViewportSize({ width, height: 320 });
      await expect(preview.getByRole("button", { name: "Close diff preview", exact: true })).toBeInViewport({ ratio: 1 });
      await expect(files).toBeInViewport(); await page.setViewportSize({ width, height: 900 });
    }
    if (width === 1440) {
      await panel.getByRole("button", { name: "Fullscreen", exact: true }).click();
      const listWide = await files.boundingBox(); const previewWide = await preview.boundingBox();
      expect(previewWide!.x).toBeGreaterThanOrEqual(listWide!.x + listWide!.width - 1);
      await panel.screenshot({ path: testInfo.outputPath("inline-wide.png") });
      await panel.getByRole("button", { name: "Exit fullscreen", exact: true }).click();
    }
    await diff.focus(); await page.keyboard.press("Escape"); await expect(preview).toHaveCount(0); await expect(file("main.txt, Modified")).toBeFocused();
    let seen!: () => void; let finished!: () => void;
    const intercepted = new Promise<void>(yes => { seen = yes; }); const done = new Promise<void>(yes => { finished = yes; });
    const gate = new Promise<void>(yes => { release = yes; });
    await page.route("**/api/workspace/git/diff", async route => {
      if (route.request().postDataJSON().path !== "slow.txt") { await route.continue(); return; }
      seen(); await gate;
      try { await route.fulfill({ json: { path: "slow.txt", area: "untracked", kind: "text", patch: "--- /dev/null\n+++ b/slow.txt\n@@ -0,0 +1 @@\n+LATE OLD CONTENT\n" } }); } catch { /* The replaced preview aborts this read. */ }
      finally { finished(); }
    });
    await file("slow.txt, Untracked").click(); await intercepted;
    await expect(preview).not.toContainText("working 0");
    await file("fast.txt, Untracked").click(); await expect(diff).toContainText("+fast.txt content"); release?.(); await done;
    await expect(preview).not.toContainText("LATE OLD CONTENT"); await page.unroute("**/api/workspace/git/diff");
    await page.route("**/api/workspace/git/diff", route => route.fulfill({ status: 503, json: { error: "unavailable", errorCode: "validation_error" } }), { times: 1 });
    await file("retry.txt, Untracked").click(); await expect(preview.getByText("Could not read this diff. Try again.", { exact: false })).toBeVisible();
    await expect(files).toBeVisible(); await preview.getByRole("button", { name: "Retry", exact: true }).click(); await expect(diff).toContainText("+retry.txt content");
    await file("fast.txt, Untracked").click(); await expect(diff).toContainText("+fast.txt content");
    await files.getByRole("button", { name: "Stage fast.txt", exact: true }).click();
    await expect(preview.getByText("Staged", { exact: true })).toBeVisible(); await expect(file("fast.txt, Added")).toHaveAttribute("aria-pressed", "true");
    await expect(diff).toContainText("+fast.txt content");
    await files.getByRole("button", { name: "Unstage fast.txt", exact: true }).click(); await expect(preview.getByText("Untracked", { exact: true })).toBeVisible();
    await files.getByRole("button", { name: "Stage fast.txt", exact: true }).click();
    await expect(preview.getByText("Staged", { exact: true })).toBeVisible();
    await panel.getByRole("textbox", { name: "Commit message", exact: true }).fill("Commit previewed file");
    const commit = panel.getByRole("button", { name: "Commit", exact: true }); await expect(commit).toBeEnabled(); await commit.click();
    await expect(preview).toHaveCount(0); await expect(file("main.txt, Modified")).toBeVisible(); expect(await readFile(join(cwd, "fast.txt"), "utf8")).toBe("fast.txt content\n");
    await file("main.txt, Modified").click(); await expect(diff).toContainText("+working 0");
    if (width === 1440) {
      bridge.publish({ type: "snapshot", session: switchSession("other", other) });
      await page.getByRole("button", { name: "Open right sidebar", exact: true }).click(); await panel.getByRole("button", { name: "Git changes", exact: true }).click();
      await expect(panel.getByText("This workspace is not in a Git repository.", { exact: true })).toBeVisible(); await expect(preview).toHaveCount(0);
      bridge.publish({ type: "snapshot", session: switchSession("terminal-a", cwd) }); await expect(diff).toContainText("+working 0"); await expect(file("main.txt, Modified")).toHaveAttribute("aria-pressed", "true");
    }
    await expect(panel.getByRole("tab")).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); expect(errors).toEqual([]);
  } finally { release?.(); await bridge.close(); await rm(cwd, { recursive: true, force: true }); await rm(other, { recursive: true, force: true }); }
});
