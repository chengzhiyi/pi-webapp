import { test, expect, type Locator } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startBridge } from "../../src/host/server/transport/bridge.ts";
import { NodeTelemetry } from "../../src/platform/telemetry/telemetry.ts";
import { terminalHost } from "../helpers/terminal-host.ts";

async function expectTopAlignedGuide(heading: Locator) {
  await expect(heading).toBeVisible();
  await expect.poll(() => heading.evaluate(node => {
    const guide = node.parentElement!;
    const body = guide.parentElement!;
    return {
      topInset: Math.round(node.getBoundingClientRect().top - body.getBoundingClientRect().top),
      extraHeight: body.scrollHeight - body.clientHeight,
      extraWidth: body.scrollWidth - body.clientWidth,
    };
  })).toEqual({ topInset: 24, extraHeight: 0, extraWidth: 0 });
  const entries = heading.locator("..").getByRole("button");
  await expect(entries).toHaveCount(3);
  const boxes = await entries.evaluateAll(nodes => nodes.map(node => {
    const box = node.getBoundingClientRect();
    return { x: box.x, y: box.y, bottom: box.bottom, width: box.width };
  }));
  for (let i = 1; i < boxes.length; i++) {
    expect(boxes[i].x).toBe(boxes[0].x);
    expect(boxes[i].width).toBe(boxes[0].width);
    expect(boxes[i].y).toBeGreaterThan(boxes[i - 1].bottom);
  }
}

for (const width of [1440, 1024, 810, 768, 390, 320]) test(`workspace guide stays at the top without unnecessary scroll at ${width}px`, async ({ page }, testInfo) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-guide-browser-"));
  const { host } = terminalHost(directory);
  const bridge = await startBridge(host, fileURLToPath(new URL("../../web/dist/", import.meta.url)), new NodeTelemetry({ env: { PI_WEB_SENTRY_ENABLED: "false" }, monitor: false }), { pluginSettingsFile: join(directory, "plugins.json") });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => { localStorage.setItem("pi-web-locale", "en"); localStorage.setItem("pi-web-theme", "light"); });
  await page.setViewportSize({ width, height: 1040 });
  const panel = page.locator("[data-sidebar-right-session]");
  const heading = panel.getByRole("heading", { name: "Workspace tools", exact: true });
  try {
    await page.goto(bridge.url);
    await page.getByRole("button", { name: "Open right sidebar", exact: true }).click();
    await expectTopAlignedGuide(heading);
    if (width >= 768) {
      await panel.getByRole("button", { name: "Fullscreen", exact: true }).click();
      await expectTopAlignedGuide(heading);
      await page.screenshot({ path: testInfo.outputPath(`guide-fullscreen-${width}.png`) });
      await panel.getByRole("button", { name: "Split", exact: true }).click();
      await expect(heading).toHaveCount(2);
      for (const item of await heading.all()) await expectTopAlignedGuide(item);
      const secondPane = panel.locator('[data-dockkit-pane][data-dockkit-column="1"]');
      await secondPane.getByRole("button", { name: "Close", exact: true }).click();
      await expect(heading).toHaveCount(1);
      await panel.getByRole("button", { name: "Exit fullscreen", exact: true }).click();
      await expectTopAlignedGuide(heading);
    }
    await page.screenshot({ path: testInfo.outputPath(`guide-${width}.png`) });
    // Small windows should still scroll naturally, without shrinking or clipping cards.
    await page.setViewportSize({ width, height: 240 });
    const guide = heading.locator("..");
    await expect.poll(() => guide.evaluate(node => node.parentElement!.scrollHeight - node.parentElement!.clientHeight)).toBeGreaterThan(0);
    const last = guide.getByRole("button").last();
    await last.focus();
    await expect(last).toBeInViewport();
    await page.setViewportSize({ width, height: 1040 });
    await expectTopAlignedGuide(heading);
    expect(errors).toEqual([]);
  } finally {
    try { if (!page.isClosed()) await page.goto("about:blank"); }
    finally { await bridge.close(); await rm(directory, { recursive: true, force: true }); }
  }
});
