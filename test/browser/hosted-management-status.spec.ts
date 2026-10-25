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
  const root = await mkdtemp(join(tmpdir(), "ori42-ui-"));
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
    const panel = page.locator("[data-hosted-management]");
    await expect(panel).toBeVisible(); await expect(panel.getByRole("combobox")).toHaveCount(0);
    const check = panel.getByRole("button", { name: locale === "en" ? "Check updates" : "检查更新", exact: true });
    await check.click();
    await expect(panel.getByRole("alert")).toHaveCount(1);
    await expect(panel.getByRole("alert")).toContainText(locale === "en" ? "not currently published" : "暂未发布");
    await expect(panel.getByRole("button", { name: locale === "en" ? "Unavailable" : "暂不可安装", exact: true })).toBeDisabled();
    await expect(check).toBeEnabled();
    // Verify actual production CSS, not just the presence of a class attribute.
    const css = await panel.locator("li").first().evaluate(el => {
      const style = getComputedStyle(el);
      return { display: style.display, border: style.borderTopWidth, color: style.color, background: getComputedStyle(document.body).backgroundColor,
        resources: performance.getEntriesByType("resource").map(e => e.name).filter(name => /\.css(?:$|\?)/.test(name)),
        styleSheets: Array.from(document.styleSheets).map(sheet => sheet.href), dark: document.body.hasAttribute("data-ds-dark-theme") };
    });
    expect(css.display).toBe("flex"); expect(css.border).toBe("1px"); expect(css.resources.length).toBeGreaterThan(0); expect(css.dark).toBe(theme === "dark");
    await writeFile(info.outputPath("actual-css.json"), JSON.stringify(css, null, 2));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`management-${locale}-${theme}-${width}.png`), fullPage: true });
    mode = "network"; await check.click();
    await expect(panel.getByRole("alert")).toContainText(locale === "en" ? "Cannot reach" : "暂时无法访问");
    await expect(panel.getByRole("button", { name: locale === "en" ? "Install" : "安装", exact: true })).toBeEnabled();
    mode = "incompatible"; await check.click();
    await expect(panel.getByRole("alert")).toContainText(locale === "en" ? "No compatible release" : "暂无适用于");
    mode = "tarball404"; await check.click(); await expect(panel).toContainText("0.1.0");
    await panel.getByRole("button", { name: locale === "en" ? "Install" : "安装", exact: true }).click();
    await expect(panel.getByRole("alert")).toContainText(locale === "en" ? "release file is unavailable" : "发行文件暂不可用");
    mode = "ok"; await check.click();
    await panel.getByRole("button", { name: locale === "en" ? "Install" : "安装", exact: true }).click();
    await expect(panel).toContainText(locale === "en" ? "Installed · Disabled" : "已安装 · 未启用");
    await expect(panel.getByRole("alert")).toHaveCount(0); expect(errors).toEqual([]);
  } finally { await integration.shutdown(); await page.close(); await bridge?.close(); await rm(root, { recursive: true, force: true }); }
});
