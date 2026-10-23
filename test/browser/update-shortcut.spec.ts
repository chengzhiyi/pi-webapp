import { test, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { startBridge, type BridgeHost } from "../../src/host/server/transport/bridge.ts";
import type { SessionView } from "../../src/host/server/sessions/view.ts";

const snapshot: SessionView = { schemaVersion: 1, sessionId: "update-test", cwd: "/tmp", name: "Update test", model: "example/model", thinkingLevel: "off", thinkingLevels: ["off"], idle: true, contextUsage: null, messages: [], pluginEntries: [] };
const host: BridgeHost = {
  snapshot: () => snapshot, models: () => [{ provider: "example", id: "model", name: "Example model" }], commands: () => [], send() {}, abort() {}, async newSession() {},
  async setModel() {}, async setThinkingLevel() {},
  config: () => ({ projectTrusted: true, global: { packages: [], extensions: [], skills: [] }, project: { packages: [], extensions: [], skills: [] }, installed: { packages: [], extensions: [], skills: [] } }),
  async updateConfig() { return this.config(); }, async workspaces() { return { items: [], activeId: null, sessions: [] }; },
  async addWorkspace() {}, async selectWorkspace() {}, async newSessionInWorkspace() {}, async removeWorkspace() {}, async selectSession() {},
};

const updateStatus = { current: "0.1.17", latest: "0.1.18", available: true, canRestart: true };

for (const state of ["latest", "unsupported", "failed"] as const) {
  test(`shortcut stays hidden when ${state}`, async ({ page }) => {
    const bridge = await startBridge(host, fileURLToPath(new URL("../../web/dist/", import.meta.url)));
    let installs = 0;
    await page.route("**/api/update", async route => {
      if (route.request().method() === "POST") installs++;
      await route.fulfill({ status: state === "failed" ? 503 : 200, contentType: "application/json", body: JSON.stringify({ ...updateStatus, available: state !== "latest", canRestart: state !== "unsupported" }) });
    });
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(bridge.url);
      await page.getByRole("button", { name: /Pi 设置|Pi Settings/ }).click();
      await expect(page.getByRole("button", { name: /^(检查更新|Check for updates)$/ })).toBeEnabled();
      await expect(page.getByRole("button", { name: /^(下载升级|Download updates)$/ })).toHaveCount(0);
      expect(installs).toBe(0);
    } finally { await bridge.close(); }
  });
}

for (const collapsed of [false, true]) {
  test(`one click directly installs; pending locks and failures allow retry (collapsed=${collapsed})`, async ({ page }) => {
    const bridge = await startBridge(host, fileURLToPath(new URL("../../web/dist/", import.meta.url)));
    let installs = 0;
    let release: () => void = () => {};
    const pending = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/api/update", async route => {
      if (route.request().method() === "POST") {
        installs++;
        await pending;
        await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Installation failed" }) });
      } else await route.fulfill({ contentType: "application/json", body: JSON.stringify(updateStatus) });
    });
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(bridge.url);
      const entry = page.getByRole("button", { name: /^(下载升级|Download updates)$/ });
      await expect(entry).toBeVisible();
      expect(installs).toBe(0);
      if (collapsed) {
        await page.getByRole("button", { name: /收起侧栏|Collapse sidebar/ }).click();
        await expect(entry).toHaveAttribute("data-wide", "false");
      }
      await entry.click();
      await expect(page.getByRole("button", { name: /正在升级|Updating/ })).toBeDisabled();
      expect(installs).toBe(1);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      release();
      await expect(page.getByRole("alert")).toContainText("Installation failed");
      await expect(entry).toBeEnabled();
      await entry.click();
      await expect.poll(() => installs).toBe(2);
    } finally { release(); await bridge.close(); }
  });
}

for (const capable of [false, true]) {
  test(`desktop package update status separates the shell version (capable=${capable})`, async ({ page }) => {
    const bridge = await startBridge(host, fileURLToPath(new URL("../../web/dist/", import.meta.url)));
    await page.route("**/api/update", route => route.fulfill({ contentType: "application/json", body: JSON.stringify(capable
      ? { ...updateStatus, desktopShell: { version: "0.1.16", build: "10" } }
      : { current: "0.1.16", latest: null, available: false, canRestart: false, reason: "当前桌面外壳尚不支持业务包在线更新，请先安装新版桌面应用。" }) }));
    try {
      await page.goto(bridge.url);
      await page.getByRole("button", { name: /Pi 设置|Pi Settings/ }).click();
      await expect(page.getByRole("button", { name: /^(检查更新|Check for updates)$/ })).toBeEnabled();
      await expect(page.getByText(/^(已是最新版本|Up to date)$/)).toHaveCount(0);
      if (capable) {
        await expect(page.getByText(/(桌面外壳|Desktop shell) 0\.1\.16 · build 10/)).toBeVisible();
        await expect(page.getByRole("button", { name: /^(升级并重启|Update and restart)$/ })).toBeEnabled();
      } else await expect(page.getByText("当前桌面外壳尚不支持业务包在线更新，请先安装新版桌面应用。")).toBeVisible();
    } finally { await bridge.close(); }
  });
}

test("successful update waits for the running version then reloads and hides the entry", async ({ page }) => {
  const bridge = await startBridge(host, fileURLToPath(new URL("../../web/dist/", import.meta.url)));
  let ready = false;
  let installs = 0;
  let versionChecks = 0;
  await page.route("**/api/update", async route => {
    if (route.request().method() === "POST") {
      installs++;
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ version: "0.1.18" }) });
    } else await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ...updateStatus, available: !ready }) });
  });
  await page.route("**/api/update/version", async route => {
    versionChecks++;
    ready = versionChecks >= 2;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ current: ready ? "0.1.18" : "0.1.17" }) });
  });
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(bridge.url);
    await page.getByRole("button", { name: /^(下载升级|Download updates)$/ }).click();
    await expect(page.getByRole("button", { name: /正在重启|Restarting/ })).toBeDisabled();
    await page.waitForEvent("domcontentloaded");
    await expect(page.getByRole("button", { name: /Pi 设置|Pi Settings/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /下载升级|Download updates/ })).toHaveCount(0);
    expect(installs).toBe(1);
    expect(versionChecks).toBeGreaterThanOrEqual(2);
  } finally { await bridge.close(); }
});
