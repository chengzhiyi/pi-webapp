import { test, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { startBridge, type BridgeHost } from "../../src/host/server/transport/bridge.ts";
import type { SessionView } from "../../src/contracts/bridge-contract.ts";

const snapshot: SessionView = { schemaVersion: 1, sessionId: "channel-test", cwd: "/tmp", name: "Channels", model: "example/model", thinkingLevel: "off", thinkingLevels: ["off"], idle: true, contextUsage: null, messages: [], pluginEntries: [] };
const host: BridgeHost = {
  snapshot: () => snapshot, models: () => [{ provider: "example", id: "model", name: "Example model" }], send() {}, abort() {}, async newSession() {}, async setModel() {}, async setThinkingLevel() {},
  config: () => ({ projectTrusted: true, global: { packages: [], extensions: [], skills: [] }, project: { packages: [], extensions: [], skills: [] }, installed: { packages: [], extensions: [], skills: [] } }),
  async updateConfig() { return this.config(); }, async workspaces() { return { items: [], activeId: null, sessions: [] }; },
  async addWorkspace() {}, async selectWorkspace() {}, async newSessionInWorkspace() {}, async removeWorkspace() {}, async selectSession() {},
};

for (const mobile of [false, true]) {
  test(`update preference persists and synchronizes the settings and shortcut (mobile=${mobile})`, async ({ page }) => {
    const bridge = await startBridge(host, fileURLToPath(new URL("../../web/dist/", import.meta.url)));
    let channel = "stable";
    const requests: unknown[] = [];
    await page.route("**/api/update/channel", async route => {
      channel = route.request().postDataJSON().channel;
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ channel }) });
    });
    await page.route("**/api/update", async route => {
      if (route.request().method() === "POST") {
        requests.push(route.request().postDataJSON());
        await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "Install test stopped" }) });
      } else await route.fulfill({ contentType: "application/json", body: JSON.stringify({ current: "0.1.29", latest: channel === "stable" ? "0.1.29" : "0.2.0-alpha.2", channel, downgrade: false, available: channel === "alpha", canRestart: true }) });
    });
    try {
      await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
      await page.goto(bridge.url);
      await page.getByRole("button", { name: /Pi 设置|Pi Settings/ }).click();
      const preference = page.getByRole("combobox", { name: /更新偏好|Update preference/ });
      await expect(preference).toHaveValue("stable");
      await preference.selectOption("alpha");
      await expect(preference).toHaveValue("alpha");
      await expect(page.getByText(/体验版包含尚在验证|Preview releases include/)).toBeVisible();
      await expect(page.getByRole("button", { name: /^(升级并重启|Update and restart)$/ })).toBeEnabled();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.reload();
      await page.getByRole("button", { name: /Pi 设置|Pi Settings/ }).click();
      await expect(preference).toHaveValue("alpha");
      await page.getByRole("button", { name: /^(升级并重启|Update and restart)$/ }).click();
      await expect(page.getByRole("alert")).toContainText("Install test stopped");
      expect(requests).toEqual([{ sessionId: "channel-test", channel: "alpha", version: "0.2.0-alpha.2" }]);
    } finally { await bridge.close(); }
  });
}

test("a stable downgrade is never sent without confirmation; confirmed request pins the target", async ({ page }) => {
  const bridge = await startBridge(host, fileURLToPath(new URL("../../web/dist/", import.meta.url)));
  const requests: unknown[] = [];
  await page.route("**/api/update", async route => {
    if (route.request().method() === "POST") {
      requests.push(route.request().postDataJSON());
      await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "Downgrade test stopped" }) });
    } else await route.fulfill({ contentType: "application/json", body: JSON.stringify({ current: "0.2.0-alpha.3", latest: "0.1.29", channel: "stable", downgrade: true, available: true, canRestart: true }) });
  });
  try {
    await page.goto(bridge.url);
    await page.getByRole("button", { name: /Pi 设置|Pi Settings/ }).click();
    const switchButton = page.getByRole("button", { name: /切换到稳定版并重启|Switch to stable and restart/ });
    await expect(switchButton).toBeEnabled();
    page.once("dialog", async dialog => {
      expect(dialog.message()).toContain("0.2.0-alpha.3"); expect(dialog.message()).toContain("0.1.29");
      await dialog.dismiss();
    });
    await switchButton.click();
    expect(requests).toHaveLength(0);
    page.once("dialog", dialog => dialog.accept());
    await switchButton.click();
    await expect(page.getByRole("alert")).toContainText("Downgrade test stopped");
    expect(requests).toEqual([{ sessionId: "channel-test", channel: "stable", version: "0.1.29", allowDowngrade: true }]);
  } finally { await bridge.close(); }
});
