import { emptyHosted } from "../helpers/empty-hosted.ts";
import { test, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { startBridge, type BridgeHost } from "../../src/host/server/transport/bridge.ts";
import type { SessionView } from "../../src/contracts/bridge-contract.ts";

const snapshot: SessionView = { schemaVersion: 1, sessionId: "channel-test", cwd: "/tmp", name: "Channels", model: "example/model", thinkingLevel: "off", thinkingLevels: ["off"], idle: true, contextUsage: null, messages: [], pluginEntries: [] };
const host: BridgeHost = {
  hosted: emptyHosted,
  snapshot: () => snapshot, models: () => [{ provider: "example", id: "model", name: "Example model" }], send() {}, abort() {}, async newSession() {}, async setModel() {}, async setThinkingLevel() {},
  config: () => ({ projectTrusted: true, global: { packages: [], extensions: [], skills: [] }, project: { packages: [], extensions: [], skills: [] }, installed: { packages: [], extensions: [], skills: [] } }),
  async updateConfig() { return this.config(); }, async workspaces() { return { items: [], activeId: null, sessions: [] }; },
  async addWorkspace() {}, async selectWorkspace() {}, async newSessionInWorkspace() {}, async removeWorkspace() {}, async selectSession() {},
};

for (const mobile of [false, true]) for (const locale of ["zh", "en"]) {
  test(`update preference matches language picker and persists (mobile=${mobile}, locale=${locale})`, async ({ page }) => {
    await page.addInitScript(locale => localStorage.setItem("pi-web-locale", locale), locale);
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
      const preference = page.getByRole("button", { name: /^(更新偏好|Update preference)$/ });
      const language = page.getByRole("button", { name: /^(语言|Language)$/ });
      await expect(preference).toHaveText(/稳定版|Stable/);
      // Both controls use the same pill, typography and right alignment.
      const style = (element: HTMLElement | SVGElement) => {
        const css = getComputedStyle(element);
        return [css.height, css.borderRadius, css.backgroundColor, css.fontSize];
      };
      for (const theme of [/^(浅色|Light)$/, /^(深色|Dark)$/]) {
        await page.getByRole("button", { name: theme }).click();
        expect(await preference.evaluate(style)).toEqual(await language.evaluate(style));
      }
      await page.getByRole("button", { name: /^(浅色|Light)$/ }).click();
      expect((await preference.boundingBox())!.x + (await preference.boundingBox())!.width).toBeCloseTo((await language.boundingBox())!.x + (await language.boundingBox())!.width, 0);
      await preference.click();
      const stable = page.getByRole("menuitemradio", { name: /稳定版|Stable/ });
      const alpha = page.getByRole("menuitemradio", { name: /体验版|Preview/ });
      await expect(stable).toHaveAttribute("aria-checked", "true");
      await expect(stable).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(alpha).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(preference).toBeFocused();
      await expect(preference).toHaveAttribute("aria-expanded", "false");
      // Escape closes only the picker, not the settings dialog.
      await expect(language).toBeVisible();
      await preference.click();
      await page.getByRole("heading", { name: /^(通用设置|General)$/ }).click();
      await expect(preference).toHaveAttribute("aria-expanded", "false");
      await preference.click();
      await alpha.click();
      await expect(preference).toHaveText(/体验版|Preview/);
      await expect(page.getByText(/体验版包含尚在验证|Preview releases include/)).toBeVisible();
      await expect(page.getByRole("button", { name: /^(升级并重启|Update and restart)$/ })).toBeEnabled();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.reload();
      await page.getByRole("button", { name: /Pi 设置|Pi Settings/ }).click();
      await expect(preference).toHaveText(/体验版|Preview/);
      await preference.click();
      await expect(page.getByRole("menuitemradio", { name: /体验版|Preview/ })).toHaveAttribute("aria-checked", "true");
      await page.screenshot({ path: `/tmp/ori23-settings-${mobile ? "mobile" : "desktop"}-${locale}.png` });
      await page.keyboard.press("Escape");
      // The shared picker still changes the UI language and returns focus.
      await language.click();
      await page.getByRole("menuitemradio", { name: locale === "zh" ? "English" : "中文", exact: true }).click();
      await expect(language).toBeFocused();
      await expect(preference).toHaveText(locale === "zh" ? "Preview (including alpha)" : "体验版（包含 alpha）");
      await page.getByRole("button", { name: /^(升级并重启|Update and restart)$/ }).click();
      await expect(page.getByRole("alert")).toContainText("Install test stopped");
      expect(requests).toEqual([{ sessionId: "channel-test", channel: "alpha", version: "0.2.0-alpha.2" }]);
    } finally { await bridge.close(); }
  });
}

test("update preference disables while saving and preserves the selection after failure", async ({ page }) => {
  const bridge = await startBridge(host, fileURLToPath(new URL("../../web/dist/", import.meta.url)));
  let channel = "stable";
  let fail = true;
  let release: (() => void) | undefined;
  await page.route("**/api/update/channel", async route => {
    if (fail) {
      await new Promise<void>(resolve => { release = resolve; });
      await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "Channel test stopped" }) });
    } else {
      channel = route.request().postDataJSON().channel;
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ channel }) });
    }
  });
  await page.route("**/api/update", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ current: "0.1.29", channel, available: false, canRestart: true }) }));
  try {
    await page.goto(bridge.url);
    await page.getByRole("button", { name: /Pi 设置|Pi Settings/ }).click();
    const preference = page.getByRole("button", { name: /^(更新偏好|Update preference)$/ });
    await expect(preference).toBeEnabled();
    await preference.click();
    const saving = page.waitForRequest("**/api/update/channel");
    await page.getByRole("menuitemradio", { name: /体验版|Preview/ }).click();
    await saving;
    await expect(preference).toBeDisabled();
    await expect(preference).toHaveAttribute("aria-expanded", "false");
    release!();
    await expect(page.getByRole("alert")).toContainText("Channel test stopped");
    await expect(preference).toBeEnabled();
    await expect(preference).toHaveText(/稳定版|Stable/);
    fail = false;
    await preference.click();
    await expect(page.getByRole("menuitemradio", { name: /稳定版|Stable/ })).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("End");
    await expect(page.getByRole("menuitemradio", { name: /体验版|Preview/ })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(preference).toHaveText(/体验版|Preview/);
    await expect(preference).toBeEnabled();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await preference.click();
    await page.keyboard.press("Home");
    await expect(page.getByRole("menuitemradio", { name: /稳定版|Stable/ })).toBeFocused();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await expect(preference).toHaveAttribute("aria-expanded", "false");
  } finally { release?.(); await bridge.close(); }
});

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

test("an old desktop shell offers its upgrade entry while preview installation stays blocked", async ({ page }) => {
  const bridge = await startBridge(host, fileURLToPath(new URL("../../web/dist/", import.meta.url)));
  let installs = 0;
  await page.route("**/api/update", route => {
    if (route.request().method() === "POST") installs++;
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({
      current: "0.1.38", channel: "alpha", latest: null, available: false, canRestart: false,
      requiresDesktopUpgrade: true, desktopShell: { version: "0.1.28", build: "10" },
      reason: "当前桌面外壳尚不支持体验版持久化，请先安装支持更新通道的新版桌面应用。",
    }) });
  });
  try {
    await page.goto(bridge.url);
    await page.getByRole("button", { name: /Pi 设置|Pi Settings/ }).click();
    await expect(page.getByText(/(后台启动时的桌面外壳|Desktop shell at backend startup) 0\.1\.28 · build 10/)).toBeVisible();
    const download = page.getByRole("link", { name: /下载新版桌面应用|Download desktop update/ });
    await expect(download).toBeVisible();
    await expect(download).toHaveAttribute("href", "https://github.com/chengzhiyi/pi-webapp/releases");
    await expect(page.getByRole("button", { name: /^(升级并重启|Update and restart)$/ })).toHaveCount(0);
    expect(installs).toBe(0);
  } finally { await bridge.close(); }
});
