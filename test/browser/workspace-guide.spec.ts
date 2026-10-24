import { test, expect, type Locator } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startBridge } from "../../src/host/server/transport/bridge.ts";
import { NodeTelemetry } from "../../src/platform/telemetry/telemetry.ts";
import { terminalHost } from "../helpers/terminal-host.ts";
import { BUILTIN_IDS } from "../../src/contracts/plugins.ts";

async function expectTopAlignedGrid(grid: Locator) {
  await expect(grid).toBeVisible();
  await expect.poll(() => grid.evaluate(node => {
    const body = node.parentElement!.parentElement!;
    return {
      topInset: Math.round(node.getBoundingClientRect().top - body.getBoundingClientRect().top),
      extraHeight: body.scrollHeight - body.clientHeight,
      extraWidth: body.scrollWidth - body.clientWidth,
    };
  })).toEqual({ topInset: 24, extraHeight: 0, extraWidth: 0 });
  const entries = grid.getByRole("button");
  await expect(entries).toHaveCount(Object.keys(BUILTIN_IDS).length);
  for (const entry of await entries.all()) await expect(entry).toBeInViewport({ ratio: 1 });
  const boxes = await entries.evaluateAll(nodes => nodes.map(node => {
    const box = node.getBoundingClientRect();
    return { x: box.x, y: box.y, bottom: box.bottom, width: box.width, height: box.height };
  }));
  const availableWidth = await grid.evaluate(node => node.clientWidth);
  const columns = Math.min(Object.keys(BUILTIN_IDS).length, Math.floor((availableWidth + 12) / (224 + 12)) || 1);
  for (let i = 0; i < boxes.length; i++) {
    expect(boxes[i].height).toBeGreaterThanOrEqual(156);
    expect(Math.abs(boxes[i].width - boxes[0].width)).toBeLessThan(1);
    if (i === 0) continue;
    if (i % columns === 0) {
      expect(boxes[i].x).toBe(boxes[0].x);
      expect(boxes[i].y).toBeGreaterThan(boxes[i - 1].bottom);
    } else {
      expect(boxes[i].y).toBe(boxes[i - 1].y);
      expect(boxes[i].x).toBeGreaterThan(boxes[i - 1].x);
    }
  }
}

const cases = [1440, 1024, 810, 768, 600, 390, 320].map(width => ({ width, locale: "en", theme: "light" }));
cases.push({ width: 810, locale: "zh", theme: "light" }, { width: 390, locale: "zh", theme: "dark" });
for (const { width, locale, theme } of cases) test(`workspace guide uses a top-aligned responsive grid at ${width}px (${locale}, ${theme})`, async ({ page }, testInfo) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-guide-browser-"));
  const { host } = terminalHost(directory);
  const bridge = await startBridge(host, fileURLToPath(new URL("../../web/dist/", import.meta.url)), new NodeTelemetry({ env: { PI_WEB_SENTRY_ENABLED: "false" }, monitor: false }), { pluginSettingsFile: join(directory, "plugins.json") });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(({ locale, theme }) => { localStorage.setItem("pi-web-locale", locale); localStorage.setItem("pi-web-theme", theme); }, { locale, theme });
  await page.setViewportSize({ width, height: 1040 });
  const panel = page.locator("[data-sidebar-right-session]");
  const grid = panel.getByRole("group", { name: locale === "zh" ? "工作区工具" : "Workspace tools", exact: true });
  const label = (en: string, zh: string) => locale === "zh" ? zh : en;
  try {
    await page.goto(bridge.url);
    await page.getByRole("button", { name: label("Open right sidebar", "打开右侧边栏"), exact: true }).click();
    await expect(panel.getByRole("heading")).toHaveCount(0);
    await expect(panel.getByText(/^(Workspace tools|工作区工具)$/)).toHaveCount(0);
    await expectTopAlignedGrid(grid);
    if (width >= 768) {
      await panel.getByRole("button", { name: label("Fullscreen", "全屏"), exact: true }).click();
      await expectTopAlignedGrid(grid);
      await page.screenshot({ path: testInfo.outputPath(`guide-fullscreen-${width}.png`), animations: "disabled" });
      await panel.getByRole("button", { name: label("Split", "分栏"), exact: true }).click();
      await expect(grid).toHaveCount(2);
      for (const item of await grid.all()) await expectTopAlignedGrid(item);
      const secondPane = panel.locator('[data-dockkit-pane][data-dockkit-column="1"]');
      await secondPane.getByRole("button", { name: label("Close", "关闭"), exact: true }).click();
      await expect(grid).toHaveCount(1);
      await panel.getByRole("button", { name: label("Exit fullscreen", "退出全屏"), exact: true }).click();
      await expectTopAlignedGrid(grid);
    }
    await page.screenshot({ path: testInfo.outputPath(`guide-${width}.png`), animations: "disabled" });
    // Cards remain reachable when the window is both narrow and short.
    await page.setViewportSize({ width: 320, height: 240 });
    await expect(panel).toHaveAttribute("data-sidebar-right-panel", "fullscreen");
    await expect.poll(() => grid.evaluate(node => node.parentElement!.parentElement!.scrollHeight - node.parentElement!.parentElement!.clientHeight)).toBeGreaterThan(0);
    const entries = grid.getByRole("button");
    const last = entries.last();
    await entries.first().focus();
    await last.focus();
    await expect(last).toBeInViewport({ ratio: 1 });
    await page.setViewportSize({ width, height: 1040 });
    await expectTopAlignedGrid(grid);
    expect(errors).toEqual([]);
  } finally {
    try { if (!page.isClosed()) await page.goto("about:blank"); }
    finally { await bridge.close(); await rm(directory, { recursive: true, force: true }); }
  }
});
