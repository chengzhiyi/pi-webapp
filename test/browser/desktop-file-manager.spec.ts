import { test, expect } from "@playwright/test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startBridge, type BridgeHost } from "../../src/host/server/transport/bridge.ts";
import { NodeTelemetry } from "../../src/platform/telemetry/telemetry.ts";
import { localFileKey, localFileLaunchUrl } from "../../desktop/local-file-grant.mjs";
import { localFileActionRoute } from "../../src/contracts/local-file-actions.ts";

for (const mode of ["darwin", "win32", "native-browser", "plain-browser"] as const) test(`system file manager menu (${mode})`, async ({ page }) => {
  const platform = mode === "native-browser" ? "win32" : mode === "plain-browser" ? null : mode;
  const cwd = await mkdtemp(join(tmpdir(), "pi-file-manager-"));
  const folder = "项目 Docs";
  const filename = "说明 file.txt";
  const host: BridgeHost = {
    snapshot: () => ({ schemaVersion: 1, sessionId: "files-a", cwd, name: "File manager", model: "example/model", thinkingLevel: null,
      thinkingLevels: [], idle: true, contextUsage: null, messages: [], pluginEntries: [] }),
    models: () => [{ provider: "example", id: "model", name: "Example" }], send() {}, abort() {}, async newSession() {}, async setModel() {}, async setThinkingLevel() {},
    config: () => ({ projectTrusted: false, global: { packages: [], extensions: [], skills: [] }, project: { packages: [], extensions: [], skills: [] }, installed: { packages: [], extensions: [], skills: [] } }),
    async updateConfig() { return this.config(); },
    async addWorkspace() {}, async selectWorkspace() {}, async newSessionInWorkspace() {}, async removeWorkspace() {}, async selectSession() {},
    async workspaces() { return { items: [{ id: "a", path: cwd, title: "Project A" }], activeId: "a", sessions: [] }; },
  };
  await mkdir(join(cwd, folder));
  await writeFile(join(cwd, folder, filename), "file preview");
  await writeFile(join(cwd, folder, "second.txt"), "second preview");
  const key = await localFileKey(cwd, true);
  expect(key).toBeDefined();
  const bridge = await startBridge(host, fileURLToPath(new URL("../../web/dist/", import.meta.url)), new NodeTelemetry({ env: { PI_WEB_SENTRY_ENABLED: "false" }, monitor: false }), {
    pluginSettingsFile: join(cwd, "plugin-settings.json"), localFileGrant: { platform: "win32", key: key! },
  });
  const calls: unknown[] = [];
  try {
    await page.exposeFunction("recordFileManagerCall", (target: unknown) => { calls.push(target); });
    await page.addInitScript((platform) => {
      localStorage.setItem("pi-web-locale", "en");
      if (platform) Object.defineProperty(window, "piDesktopFileManager", { value: {
        platform,
        async listApps(target: { kind: string }) {
          return { ok: true, apps: target.kind === "file"
            ? [{ id: "default", name: "System Editor", isDefault: true }, { id: "other", name: "Other Editor" }]
            : [{ id: "project", name: "Project Editor" }] };
        },
        async openWith(target: unknown, id: string) {
          const recorder = window as unknown as { recordFileManagerCall(target: unknown): Promise<void> };
          await recorder.recordFileManagerCall({ target, id });
          return { ok: true };
        },
        async show(target: { path: string }) {
          const recorder = window as unknown as { recordFileManagerCall(target: unknown): Promise<void> };
          await recorder.recordFileManagerCall(target);
          return target.path.endsWith(".txt") ? { ok: false, reason: "not-found" } : { ok: true };
        },
      } });
    }, mode === "native-browser" ? null : platform);
    await page.setViewportSize({ width: 1440, height: 900 });
    const launchUrl = mode === "native-browser" ? await localFileLaunchUrl(bridge.url, "win32", { SESSIONNAME: "Console" }, cwd) : bridge.url;
    if (mode === "native-browser") {
      expect(launchUrl).not.toBe(bridge.url);
      await page.route(`**${localFileActionRoute}`, async route => {
        if (route.request().method() === "GET") return route.continue();
        const { operation, target, appId } = route.request().postDataJSON();
        expect(route.request().headers()["x-pi-local-files"]).toBe(new URL(launchUrl).hash.split(".")[1]);
        if (operation === "list") return route.fulfill({ json: { ok: true, apps: target.kind === "file"
          ? [{ id: "default", name: "System Editor", isDefault: true }, { id: "other", name: "Other Editor" }]
          : [{ id: "project", name: "Project Editor" }] } });
        calls.push(operation === "show" ? target : { target, id: appId });
        return route.fulfill({ json: operation === "show" && target.path.endsWith(".txt") ? { ok: false, reason: "not-found" } : { ok: true } });
      });
    }
    await page.goto(launchUrl);
    if (mode === "native-browser") {
      await expect(page).toHaveURL(new URL(bridge.url).origin + "/");
      await page.reload(); // The grant is kept in tab storage, not in the visible URL.
    }
    const system = platform === "darwin" ? "Finder" : "File Explorer";
    const open = page.getByRole("menuitem", { name: `Open in ${system}`, exact: true });
    const reveal = page.getByRole("menuitem", { name: `Show in ${system}`, exact: true });
    await page.getByRole("button", { name: "Project A", exact: true }).click({ button: "right" });
    await expect(page.getByRole("menuitem", { name: "Remove workspace from list" })).toBeVisible();
    if (platform) await open.click();
    else {
      await expect(page.getByRole("menuitem", { name: /Finder|File Explorer/ })).toHaveCount(0);
      await page.keyboard.press("Escape");
    }
    await page.getByRole("button", { name: "Open right sidebar", exact: true }).click();
    const rightbar = page.locator("[data-sidebar-right-session]");
    await rightbar.getByRole("button", { name: "Workspace files", exact: true }).click();
    const tree = page.getByRole("tree", { name: "Workspace files" });
    const directory = tree.getByRole("treeitem", { name: folder, exact: true });
    await directory.click({ button: "right" });
    await expect(directory).toHaveAttribute("aria-expanded", "false");
    if (!platform) {
      await expect(page.getByRole("menuitem", { name: /Finder|File Explorer/ })).toHaveCount(0);
      expect(calls).toEqual([]);
      await expect(rightbar.getByRole("button", { name: "Choose an app to open with" })).toHaveCount(0);
      return;
    }
    await open.click();
    await directory.click();
    const picker = rightbar.getByRole("button", { name: "Choose an app to open with" });
    await picker.click();
    await page.getByRole("menuitemradio", { name: "Project Editor" }).click();
    await rightbar.getByRole("button", { name: "Open with Project Editor" }).click();
    const file = tree.getByRole("treeitem", { name: filename, exact: true });
    await file.press("Shift+F10");
    await expect(reveal).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(file).toBeFocused();
    await file.click({ button: "right" });
    await reveal.click();
    await expect(file).toHaveAttribute("aria-selected", "false");
    await expect(page.getByRole("alert").filter({ hasText: "File or folder not found" })).toBeVisible();
    await file.click();
    await expect(rightbar.getByRole("button", { name: "Open with System Editor" })).toBeEnabled();
    await picker.click();
    await expect(page.getByRole("menuitemradio", { name: /System Editor/ })).toHaveAttribute("aria-checked", "true");
    await expect(page.getByRole("menuitemradio", { name: `Show in ${system}` })).toBeVisible();
    await page.getByRole("menuitemradio", { name: "Other Editor" }).click();
    await expect.poll(() => calls.length).toBe(4); // Choosing does not launch anything.
    await tree.getByRole("treeitem", { name: "second.txt" }).click();
    await rightbar.getByRole("button", { name: "Open with Other Editor" }).click();
    await file.click();
    await rightbar.getByRole("navigation", { name: "File path" }).filter({ visible: true }).getByRole("button", { name: folder, exact: true }).click();
    const breadcrumbMenu = page.getByRole("dialog", { name: `Files in ${folder}`, exact: true });
    const breadcrumbFile = breadcrumbMenu.getByRole("treeitem", { name: filename, exact: true });
    await breadcrumbFile.click({ button: "right" });
    await page.keyboard.press("Escape");
    await expect(reveal).toHaveCount(0);
    await expect(breadcrumbFile).toBeFocused();
    await breadcrumbFile.click({ button: "right" });
    await reveal.click();
    await expect(breadcrumbMenu).toBeVisible();
    await expect.poll(() => calls.length).toBe(6);
    expect(calls).toEqual([
      { workspaceId: "a", path: "", kind: "directory" },
      { sessionId: "files-a", path: folder, kind: "directory" },
      { target: { sessionId: "files-a", path: folder, kind: "directory" }, id: "project" },
      { sessionId: "files-a", path: `${folder}/${filename}`, kind: "file" },
      { target: { sessionId: "files-a", path: `${folder}/second.txt`, kind: "file" }, id: "other" },
      { sessionId: "files-a", path: `${folder}/${filename}`, kind: "file" },
    ]);
  } finally { await bridge.close(); await rm(cwd, { recursive: true, force: true }); }
});
