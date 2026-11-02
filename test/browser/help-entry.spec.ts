import { emptyHosted } from "../helpers/empty-hosted.ts";
import { test, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { startBridge, type BridgeHost } from "../../src/host/server/transport/bridge.ts";
import type { SessionView } from "../../src/host/server/sessions/view.ts";

const snapshot: SessionView = { schemaVersion: 1, sessionId: "help-test", cwd: "/tmp", name: "Help test", model: "example/model", thinkingLevel: "off", thinkingLevels: ["off"], idle: true, contextUsage: null, messages: [], pluginEntries: [] };
const host: BridgeHost = {
  hosted: emptyHosted,
  snapshot: () => snapshot, models: () => [{ provider: "example", id: "model", name: "Example model" }], commands: () => [], send() {}, abort() {}, async newSession() {},
  async setModel() {}, async setThinkingLevel() {},
  config: () => ({ projectTrusted: true, global: { packages: [], extensions: [], skills: [] }, project: { packages: [], extensions: [], skills: [] }, installed: { packages: [], extensions: [], skills: [] } }),
  async updateConfig() { return this.config(); }, async workspaces() { return { items: [], activeId: null, sessions: [] }; },
  async addWorkspace() {}, async selectWorkspace() {}, async newSessionInWorkspace() {}, async removeWorkspace() {}, async selectSession() {},
};

const pages = [
  [/^(使用文档|Documentation)$/, "https://pi.emath.top/"],
  [/^(快速开始|Quick start)$/, "https://pi.emath.top/getting-started"],
  [/^(故障排查|Troubleshooting)$/, "https://pi.emath.top/troubleshooting"],
  [/^(在 GitHub 上反馈问题|Report an issue on GitHub)$/, "https://github.com/chengzhiyi/pi-webapp/issues"],
] as const;

for (const collapsed of [false, true]) {
  test(`the sidebar help menu links to the English docs (collapsed=${collapsed})`, async ({ page }) => {
    const bridge = await startBridge(host, fileURLToPath(new URL("../../web/dist/", import.meta.url)));
    try {
      await page.addInitScript(() => localStorage.setItem("pi-web-locale", "en"));
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(bridge.url);
      if (collapsed) await page.getByRole("button", { name: "Collapse sidebar" }).click();
      const trigger = page.getByRole("button", { name: "Help & documentation" });
      await expect(trigger).toHaveAttribute("data-wide", String(!collapsed));
      await trigger.click();
      const menu = page.getByRole("menu", { name: "Help & documentation" });
      await expect(menu.getByRole("menuitem").first()).toBeFocused();
      for (const [name, href] of pages) {
        await expect(menu.getByRole("menuitem", { name })).toHaveAttribute("href", href);
        await expect(menu.getByRole("menuitem", { name })).toHaveAttribute("target", "_blank");
      }
      const box = await menu.boundingBox();
      const anchor = await trigger.boundingBox();
      expect(box!.y + box!.height).toBeLessThanOrEqual(anchor!.y);
      await page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);
      await expect(trigger).toBeFocused();
    } finally { await bridge.close(); }
  });
}

test("Settings → General links to the Chinese docs", async ({ page }) => {
  const bridge = await startBridge(host, fileURLToPath(new URL("../../web/dist/", import.meta.url)));
  try {
    await page.addInitScript(() => localStorage.setItem("pi-web-locale", "zh"));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(bridge.url);
    await page.getByRole("button", { name: "Pi 设置" }).click();
    const row = page.getByRole("region", { name: "帮助与文档" });
    await expect(row.getByRole("link", { name: "使用文档" })).toHaveAttribute("href", "https://pi.emath.top/zh/");
    await expect(row.getByRole("link", { name: "故障排查" })).toHaveAttribute("href", "https://pi.emath.top/zh/troubleshooting");
  } finally { await bridge.close(); }
});
