import { test, expect } from "@playwright/test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostedPluginIntegration } from "../../src/host/server/plugins/hosted/integration.ts";
import { startBridge, type Bridge } from "../../src/host/server/transport/bridge.ts";
import { NodeTelemetry } from "../../src/platform/telemetry/telemetry.ts";
import { terminalHost } from "../helpers/terminal-host.ts";
import { integrationFixture } from "../helpers/hosted-integration-fixture.ts";

// Real App + HTTP + installer; only the trusted registry's responses are local fixtures.
for (const locale of ["en", "zh"] as const) for (const theme of ["light", "dark"] as const) for (const width of [390, 1440]) test(`official plugin status ${locale}/${theme}/${width}`, async ({ page }, info) => {
  test.setTimeout(45_000);
  const root = await mkdtemp(join(tmpdir(), "ori51-ui-"));
  let mode: "metadata404" | "tarball404" | "network" | "incompatible" | "ok" = "metadata404", bridge: Bridge | undefined;
  const fixture = integrationFixture();
  const integration = new HostedPluginIntegration({ root, workerEntry: "unused", hostVersion: "0.1.29", ownerId: "ui-fixture", resolveSession: () => null,
    fetch: (async url => {
      if (mode === "network") throw new TypeError("LOCAL FIXTURE: registry offline");
      if (mode === "metadata404" || String(url).endsWith(".tgz") && mode === "tarball404") return new Response("LOCAL FIXTURE: absent", { status: 404 });
      if (String(url).endsWith(".tgz")) return new Response(new Uint8Array(fixture.bytes));
      return Response.json({ versions: mode === "incompatible" ? {} : { "0.1.0": fixture.release } });
    }) as typeof fetch });
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  try {
    await integration.start();
    const { host } = terminalHost(root); host.hosted = integration.handlers;
    bridge = await startBridge(host, new URL("../../web/dist", import.meta.url).pathname, new NodeTelemetry({ env: { PI_WEB_SENTRY_ENABLED: "false" }, monitor: false }), { pluginSettingsFile: join(root, "plugins.json") });
    await page.setViewportSize({ width, height: 1000 });
    await page.addInitScript(({ locale, theme }) => { localStorage.setItem("pi-web-locale", locale); localStorage.setItem("pi-web-theme", theme); }, { locale, theme });
    await page.goto(bridge.url);
    await page.getByRole("button", { name: locale === "en" ? "Plugins" : "插件", exact: true }).click();
    const panel = page.locator("[data-hosted-management]"), row = panel.locator("li");
    const toggle = panel.getByRole("switch", { name: locale === "en" ? "Enable Excalidraw" : "启用 Excalidraw", exact: true });
    const open = panel.getByRole("button", { name: locale === "en" ? "Excalidraw (Official)" : "Excalidraw（官方）", exact: true });
    await expect(row).toBeVisible(); await expect(toggle).toBeDisabled(); await expect(toggle).not.toBeChecked();
    await expect(panel.getByRole("button", { name: locale === "en" ? "Download" : "下载", exact: true })).toBeEnabled();
    await expect(panel.getByRole("button", { name: locale === "en" ? "Reload status" : "重新读取状态", exact: true })).toHaveCount(0);
    // Official and built-in rows/switches use exactly the same production classes and dimensions.
    const builtin = page.locator("[data-plugin-package]").first();
    expect(await row.getAttribute("class")).toBe(await builtin.getAttribute("class"));
    expect(await toggle.getAttribute("class")).toBe(await builtin.getByRole("switch").getAttribute("class"));
    const css = await row.evaluate(el => {
      const style = getComputedStyle(el);
      return { display: style.display, border: style.borderTopWidth, dark: document.body.hasAttribute("data-ds-dark-theme") };
    });
    expect(css.display).toBe("flex"); expect(css.border).toBe("0px"); expect(css.dark).toBe(theme === "dark");
    await writeFile(info.outputPath("actual-css.json"), JSON.stringify(css, null, 2));
    const search = page.getByRole("searchbox", { name: locale === "en" ? "Search plugins" : "搜索插件", exact: true });
    await search.fill("Excalidraw"); await expect(row).toBeVisible(); await expect(builtin).toHaveCount(0);
    await search.fill("Terminal"); await expect(row).toHaveCount(0);
    await search.fill("");
    await page.screenshot({ path: info.outputPath(`list-${locale}-${theme}-${width}.png`), fullPage: true });
    await open.click();
    await expect(page.getByRole("heading", { name: "Excalidraw", exact: true })).toBeVisible();
    await expect(page.locator("[data-plugin-package]")).toHaveCount(0);
    await expect(panel.getByRole("combobox")).toHaveCount(0);
    await expect(panel).toContainText(locale === "en" ? "No additional configuration" : "无需额外配置");
    const check = panel.getByRole("button", { name: locale === "en" ? "Check updates" : "检查更新", exact: true });
    await check.click();
    await expect(panel.getByRole("alert")).toHaveCount(1);
    await expect(panel.getByRole("alert")).toContainText(locale === "en" ? "not currently published" : "暂未发布");
    await expect(panel.getByRole("button", { name: locale === "en" ? "Unavailable" : "暂不可下载", exact: true })).toBeDisabled();
    await expect(check).toBeEnabled();
    mode = "network"; await check.click();
    await expect(panel.getByRole("alert")).toContainText(locale === "en" ? "Cannot reach" : "暂时无法访问");
    await expect(panel.getByRole("button", { name: locale === "en" ? "Download" : "下载", exact: true })).toBeEnabled();
    mode = "incompatible"; await check.click();
    await expect(panel.getByRole("alert")).toContainText(locale === "en" ? "No compatible release" : "暂无适用于");
    mode = "tarball404"; await check.click(); await expect(panel).toContainText("0.1.0");
    await panel.getByRole("button", { name: locale === "en" ? "Download" : "下载", exact: true }).click();
    await expect(panel.getByRole("alert")).toContainText(locale === "en" ? "release file is unavailable" : "发行文件暂不可用");
    mode = "ok"; await check.click();
    await panel.getByRole("button", { name: locale === "en" ? "Download" : "下载", exact: true }).click();
    await expect(panel).toContainText(locale === "en" ? "Installed · Disabled" : "已安装 · 未启用");
    await expect(toggle).toBeEnabled(); await expect(toggle).not.toBeChecked();
    await expect(panel.getByRole("alert")).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`detail-${locale}-${theme}-${width}.png`), fullPage: true });
    await page.getByRole("button", { name: locale === "en" ? "‹ Plugins" : "‹ 插件", exact: true }).click();
    await expect(row).toBeVisible(); await expect(panel.getByRole("button", { name: locale === "en" ? "Update" : "更新", exact: true })).toBeEnabled();
    await expect(page.locator("[data-hosted-detail]")).toHaveCount(0);
    // Built-in detail must not leave the official catalog appended underneath it.
    await page.locator("[data-plugin-package]").first().getByRole("button").first().click();
    await expect(panel).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  } finally { await integration.shutdown(); await page.close(); await bridge?.close(); await rm(root, { recursive: true, force: true }); }
});
