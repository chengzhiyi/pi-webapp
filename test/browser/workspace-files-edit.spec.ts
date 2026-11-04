import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startBridge, type Bridge, type BridgeHost } from "../../src/host/server/transport/bridge.ts";
import { NodeTelemetry } from "../../src/platform/telemetry/telemetry.ts";
import type { SessionView } from "../../src/host/server/sessions/view.ts";

test("workspace files show Git status, search names and contents, and edit with conflict protection", async ({ page }, testInfo) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-files-edit-"));
  for (const directory of ["docs", "src", "node_modules/pkg", "web"]) await mkdir(join(cwd, directory), { recursive: true });
  await writeFile(join(cwd, ".gitignore"), "node_modules/\n");
  await writeFile(join(cwd, "src", "main.ts"), Array.from({ length: 80 }, (_, index) => index === 60 ? "export const needle = 'haystack';" : `// filler ${index}`).join("\n") + "\n");
  await writeFile(join(cwd, "src", "util.ts"), "export const util = 1;\n");
  await writeFile(join(cwd, "src", "crlf.txt"), "first\r\nsecond\r\n");
  await writeFile(join(cwd, "web", "index.html"), "<p>needle</p>\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd });
  git("init", "-q"); git("add", "."); git("-c", "user.email=files@example.com", "-c", "user.name=Files", "commit", "-qm", "init");
  await writeFile(join(cwd, "src", "util.ts"), "export const util = 2;\n");
  await mkdir(join(cwd, "notes")); await writeFile(join(cwd, "notes", "todo.md"), "# Todo\n\n- item\n");
  const session: SessionView = { schemaVersion: 1, sessionId: "files-edit", cwd, name: "Files", model: "example/model", thinkingLevel: "off", thinkingLevels: ["off"], idle: true, contextUsage: null, messages: [], pluginEntries: [] };
  let bridge: Bridge | undefined;
  const host: BridgeHost = {
    snapshot: () => session, models: () => [{ provider: "example", id: "model", name: "Example" }], send() {}, abort() {}, async newSession() {}, async setModel() {}, async setThinkingLevel() {},
    config: () => ({ projectTrusted: false, global: { packages: [], extensions: [], skills: [] }, project: { packages: [], extensions: [], skills: [] }, installed: { packages: [], extensions: [], skills: [] } }),
    async updateConfig() { return this.config(); },
    async workspaces() { return { items: [{ id: "a", path: cwd, title: "Workspace" }], activeId: "a", sessions: [{ id: "files-edit", workspaceId: "a", path: null, name: "Chat", modified: new Date().toISOString() }] }; },
    async addWorkspace() {}, async selectWorkspace() {}, async newSessionInWorkspace() {}, async removeWorkspace() {}, async selectSession() {},
  };
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => { localStorage.setItem("pi-web-locale", "en"); localStorage.setItem("pi-web-theme", "light"); });
  await page.setViewportSize({ width: 1440, height: 900 });
  const rightbar = page.locator("[data-sidebar-right-session]");
  const tree = page.getByRole("tree", { name: "Workspace files" });
  const editor = (name: string) => rightbar.getByRole("textbox", { name: `Edit ${name}`, exact: true });
  const code = rightbar.locator(".cm-content:visible");
  const unsaved = rightbar.getByText("Unsaved", { exact: true });
  try {
    bridge = await startBridge(host, fileURLToPath(new URL("../../web/dist/", import.meta.url)), new NodeTelemetry({ env: { PI_WEB_SENTRY_ENABLED: "false" }, monitor: false }));
    await page.goto(bridge.url);
    await page.getByRole("button", { name: "Open right sidebar", exact: true }).click();
    await rightbar.getByRole("button", { name: "Workspace files", exact: true }).click();

    await expect(rightbar.getByText("Open files appear here", { exact: true })).toBeVisible();
    // Status: changes colour their folders, untracked folders and ignored folders are marked, .git is hidden.
    await expect(tree.getByRole("treeitem", { name: "src", exact: true })).toHaveAttribute("data-git-status", "modified");
    await expect(tree.getByRole("treeitem", { name: "notes", exact: true })).toHaveAttribute("data-git-status", "untracked");
    await expect(tree.getByRole("treeitem", { name: "node_modules", exact: true })).toHaveAttribute("data-git-status", "ignored");
    await expect(tree.getByRole("treeitem", { name: "docs", exact: true })).not.toHaveAttribute("data-git-status");
    await expect(tree.getByRole("treeitem", { name: ".git", exact: true })).toHaveCount(0);
    await tree.getByRole("treeitem", { name: "src", exact: true }).click();
    await expect(tree.getByRole("treeitem", { name: "util.ts", exact: true })).toHaveAttribute("data-git-status", "modified");
    await expect(tree.getByRole("treeitem", { name: "main.ts", exact: true })).not.toHaveAttribute("data-git-status");
    await page.screenshot({ path: testInfo.outputPath("status.png") });

    // Name filter, then "?" content search that opens the file at the matching line.
    const search = rightbar.getByRole("searchbox", { name: /Filter files/ });
    await search.fill("util");
    await expect(rightbar.getByRole("list", { name: "Matching files" }).getByRole("button")).toHaveCount(1);
    await search.press("Enter");
    await expect(code).toContainText("util = 2");
    // The editor highlights the language without any extra step.
    // Keywords take --shiki-token-keyword (light theme #d6336c), the same colour as read-only code blocks.
    await expect(rightbar.locator(".cm-content:visible span").filter({ hasText: /^export$/ })).toHaveCSS("color", "rgb(214, 51, 108)");
    // More than the old 10,000-line preview cap still opens in the editor.
    await writeFile(join(cwd, "src", "long.txt"), Array.from({ length: 12000 }, (_, index) => `line ${index + 1}`).join("\n"));
    await search.fill("long.txt");
    await expect(rightbar.getByRole("list", { name: "Matching files" }).getByRole("button", { name: /long\.txt/ })).toBeVisible();
    await search.press("Enter");
    await expect(editor("long.txt")).toContainText("line 1");
    // ⌘/Ctrl+F opens the floating Find box: type-ahead selects the first match, Enter steps, Esc closes.
    await editor("long.txt").click();
    await editor("long.txt").press("ControlOrMeta+Home");
    await editor("long.txt").press("ControlOrMeta+f");
    const find = rightbar.getByRole("textbox", { name: "Find in file", exact: true });
    await expect(find).toBeFocused();
    await find.fill("line 12");
    const findBox = rightbar.getByRole("search");
    await expect(findBox).toContainText("1/112");
    await find.press("Enter");
    await expect(findBox).toContainText("2/112");
    await find.press("Shift+Enter");
    await expect(findBox).toContainText("1/112");
    await find.fill("no such text");
    await expect(findBox).toContainText("No results");
    await page.screenshot({ path: testInfo.outputPath("find.png") });
    await find.press("Escape");
    await expect(findBox).toHaveCount(0);
    await expect(editor("long.txt")).toBeFocused();
    await search.fill("?needle");
    const hit = rightbar.getByRole("button", { name: "src/main.ts line 61: export const needle = 'haystack';", exact: true });
    await expect(rightbar.getByRole("button", { name: /web\/index\.html line 1/ })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("search.png") });
    await hit.click();
    await expect(rightbar.locator(".cm-activeLine:visible")).toContainText("export const needle");
    await search.press("Escape");
    await expect(tree).toBeVisible();

    // Code files are editable as soon as they open; Tab indents and ⌘/Ctrl+S saves.
    await tree.getByRole("treeitem", { name: "util.ts", exact: true }).click();
    await expect(rightbar.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
    await editor("util.ts").fill("export const util = 3;\n");
    await editor("util.ts").press("ControlOrMeta+End");
    await editor("util.ts").press("Tab");
    await expect(unsaved).toBeVisible();
    await editor("util.ts").press("ControlOrMeta+s");
    await expect(unsaved).toHaveCount(0);
    expect(await readFile(join(cwd, "src", "util.ts"), "utf8")).toBe("export const util = 3;\n  ");

    // A change on disk during editing is never overwritten silently.
    await writeFile(join(cwd, "src", "util.ts"), "changed elsewhere\n");
    await editor("util.ts").fill("mine\n");
    await rightbar.getByRole("button", { name: "Save", exact: true }).click();
    await expect(rightbar.getByRole("alert")).toContainText("changed on disk");
    await page.screenshot({ path: testInfo.outputPath("editor.png") });
    expect(await readFile(join(cwd, "src", "util.ts"), "utf8")).toBe("changed elsewhere\n");
    await page.screenshot({ path: testInfo.outputPath("conflict.png") });
    await rightbar.getByRole("button", { name: "Overwrite", exact: true }).click();
    await expect(unsaved).toHaveCount(0);
    expect(await readFile(join(cwd, "src", "util.ts"), "utf8")).toBe("mine\n");

    // Leaving with unsaved edits asks first; CRLF files keep their line endings.
    await editor("util.ts").fill("draft\n");
    page.once("dialog", dialog => void dialog.dismiss());
    await tree.getByRole("treeitem", { name: "crlf.txt", exact: true }).click();
    await expect(editor("util.ts")).toContainText("draft");
    page.once("dialog", dialog => void dialog.accept());
    await tree.getByRole("treeitem", { name: "crlf.txt", exact: true }).click();
    await editor("crlf.txt").fill("first\nsecond\nthird\n");
    await rightbar.getByRole("button", { name: "Save", exact: true }).click();
    await expect(unsaved).toHaveCount(0);
    expect(await readFile(join(cwd, "src", "crlf.txt"), "utf8")).toBe("first\r\nsecond\r\nthird\r\n");

    // Markdown opens rendered; Edit switches to the editor and Preview renders unsaved edits.
    await tree.getByRole("treeitem", { name: "notes", exact: true }).click();
    await tree.getByRole("treeitem", { name: "todo.md", exact: true }).click();
    await expect(rightbar.getByRole("heading", { name: "Todo", exact: true })).toBeVisible();
    await rightbar.getByRole("button", { name: "Edit", exact: true }).click();
    await editor("todo.md").fill("# Done list\n\n- shipped\n");
    await page.screenshot({ path: testInfo.outputPath("markdown-edit.png") });
    await rightbar.getByRole("button", { name: "Preview", exact: true }).click();
    await expect(rightbar.getByRole("heading", { name: "Done list", exact: true })).toBeVisible();
    await expect(unsaved).toBeVisible();
    await rightbar.getByRole("button", { name: "Save", exact: true }).click();
    await expect(unsaved).toHaveCount(0);
    expect(await readFile(join(cwd, "notes", "todo.md"), "utf8")).toBe("# Done list\n\n- shipped\n");
    expect(errors).toEqual([]);
  } finally { await bridge?.close(); await rm(cwd, { recursive: true, force: true }); }
});
