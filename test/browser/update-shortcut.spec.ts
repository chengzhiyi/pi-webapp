import { test, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { startBridge, type BridgeHost } from "../../extension/bridge.ts";
import type { SessionView } from "../../extension/view.ts";

const snapshot: SessionView = { schemaVersion: 1, sessionId: "update-test", cwd: "/tmp", name: "Update test", model: "example/model", thinkingLevel: "off", thinkingLevels: ["off"], idle: true, contextUsage: null, messages: [], pluginEntries: [] };
const host: BridgeHost = {
  snapshot: () => snapshot, models: () => [{ provider: "example", id: "model", name: "Example model" }], commands: () => [], send() {}, abort() {}, async newSession() {},
  async setModel() {}, async setThinkingLevel() {},
  config: () => ({ projectTrusted: true, global: { packages: [], extensions: [], skills: [] }, project: { packages: [], extensions: [], skills: [] }, installed: { packages: [], extensions: [], skills: [] } }),
  async updateConfig() { return this.config(); }, async workspaces() { return { items: [], activeId: null, sessions: [] }; },
  async addWorkspace() {}, async selectWorkspace() {}, async newSessionInWorkspace() {}, async removeWorkspace() {}, async selectSession() {},
};

for (const available of [false, true]) {
  test(`sidebar update shortcut works expanded and collapsed (available=${available})`, async ({ page }) => {
    const bridge = await startBridge(host, fileURLToPath(new URL("../../web/dist/", import.meta.url)));
    let installs = 0;
    await page.route("**/api/update", async route => {
      if (route.request().method() === "POST") {
        installs++;
        await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Installation failed" }) });
      } else await route.fulfill({ contentType: "application/json", body: JSON.stringify({ current: "0.1.17", latest: available ? "0.1.18" : "0.1.17", available, canRestart: true }) });
    });
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(bridge.url);
      const entry = page.getByRole("button", { name: /^(下载升级|Download updates)$/ });
      await expect(entry).toBeVisible();
      if (available) await expect(entry).toContainText(/有新版本|New version available/);
      expect(installs).toBe(0);
      await entry.click();
      const dialog = page.getByRole("dialog", { name: /下载升级|Download updates/ });
      await expect(dialog).toContainText("0.1.17");
      if (available) {
        await dialog.getByRole("button", { name: /升级并重启|Update and restart/ }).click();
        await expect(dialog.getByRole("alert")).toBeVisible();
        expect(installs).toBe(1);
      } else await expect(dialog.getByRole("status")).toHaveText(/已是最新版本|Up to date/);
      await page.keyboard.press("Escape");
      await expect(dialog).not.toBeVisible();
      await expect(entry).toBeFocused();
      await page.getByRole("button", { name: /收起侧栏|Collapse sidebar/ }).click();
      await expect(entry).toHaveAttribute("data-wide", "false");
      await entry.click();
      await expect(dialog).toBeVisible();
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: /Pi 设置|Pi Settings/ }).click();
      await expect(page.getByRole("button", { name: /检查更新|Check for updates/ })).toBeVisible();
    } finally { await bridge.close(); }
  });
}
