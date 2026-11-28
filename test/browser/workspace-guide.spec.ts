import { test, expect, type Locator } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startBridge } from "../../src/host/server/transport/bridge.ts";
import { NodeTelemetry } from "../../src/platform/telemetry/telemetry.ts";
import { terminalHost } from "../helpers/terminal-host.ts";
import type { WebPreviewDesktop } from "../../src/plugins/builtin/web-preview/client/desktop-api.ts";
import type { HostedPluginCard } from "../../src/contracts/hosted-plugins.ts";
import { emptyHosted } from "../helpers/empty-hosted.ts";
import { OFFICIAL_ENTRIES } from "../../src/host/server/plugins/hosted/official-catalog.ts";
// Only enabled workspace capabilities have launchers; the optional drawing
// package is absent in this fixture. Historical drawing recovery has no launcher.
const launcherLabels = { en: ["Git changes", "Workspace files", "Open terminal"], zh: ["Git 改动", "工作区文件", "打开终端"] };

async function expectTopAlignedGrid(grid: Locator, locale: "zh" | "en", desktop: boolean) {
  await expect(grid).toBeVisible();
  const workspace = grid.getByRole("group", { name: locale === "zh" ? "工作区" : "Workspace", exact: true });
  const preview = locale === "zh" ? "网页预览" : "Web Preview";
  const labels = desktop ? [...launcherLabels[locale], preview] : launcherLabels[locale];
  await expect.poll(() => grid.evaluate(node => {
    const body = node.parentElement!.parentElement!;
    return {
      topInset: Math.round(node.getBoundingClientRect().top - body.getBoundingClientRect().top),
      extraHeight: body.scrollHeight - body.clientHeight,
      extraWidth: body.scrollWidth - body.clientWidth,
    };
  })).toEqual({ topInset: 24, extraHeight: 0, extraWidth: 0 });
  const entries = workspace.getByRole("button");
  await expect(entries).toHaveCount(labels.length);
  await expect(grid.getByRole("heading")).toHaveCount(1);
  await expect(grid.getByRole("button", { name: "Excalidraw", exact: true })).toHaveCount(0);
  await expect(workspace.getByRole("button", { name: preview, exact: true })).toHaveCount(desktop ? 1 : 0);
  for (const label of labels) await expect(workspace.getByRole("button", { name: label, exact: true })).toHaveCount(1);
  for (const entry of await entries.all()) await expect(entry).toBeInViewport({ ratio: 1 });
  const boxes = await entries.evaluateAll(nodes => nodes.map(node => {
    const box = node.getBoundingClientRect();
    return { x: box.x, y: box.y, bottom: box.bottom, width: box.width, height: box.height, border: getComputedStyle(node).borderTopWidth };
  }));
  const availableWidth = await workspace.evaluate(node => node.clientWidth);
  const columns = Math.min(labels.length, Math.floor((availableWidth + 12) / (180 + 12)) || 1);
  for (let i = 0; i < boxes.length; i++) {
    expect(boxes[i].border).toBe("0px");
    expect(boxes[i].height).toBeGreaterThanOrEqual(104);
    expect(boxes[i].height).toBeLessThan(156);
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

const cases: { width: number; locale: "zh" | "en"; theme: string; desktop?: boolean }[] = [1440, 1024, 810, 768, 600, 390, 320].map(width => ({ width, locale: "en", theme: "light" }));
cases.push({ width: 810, locale: "zh", theme: "light" }, { width: 390, locale: "zh", theme: "dark" }, { width: 1440, locale: "en", theme: "light", desktop: true });
for (const { width, locale, theme, desktop = false } of cases) test(`workspace guide uses a top-aligned responsive grid at ${width}px (${locale}, ${theme}${desktop ? ", desktop" : ""})`, async ({ page }, testInfo) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-guide-browser-"));
  const { host } = terminalHost(directory);
  const bridge = await startBridge(host, fileURLToPath(new URL("../../web/dist/", import.meta.url)), new NodeTelemetry({ env: { PI_WEB_SENTRY_ENABLED: "false" }, monitor: false }), { pluginSettingsFile: join(directory, "plugins.json") });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(({ locale, theme, desktop }) => {
    localStorage.setItem("pi-web-locale", locale);
    localStorage.setItem("pi-web-theme", theme);
    if (!desktop) return;
    const bridge: WebPreviewDesktop = {
      async open(_id, url) { return { status: "ready", url, canGoBack: false, canGoForward: false }; },
      async command() { return { status: "idle", url: "", canGoBack: false, canGoForward: false }; },
      layout() {}, close() {}, onState() { return () => {}; },
    };
    Object.assign(window, { piWebPreview: bridge });
  }, { locale, theme, desktop });
  await page.setViewportSize({ width, height: 1040 });
  const panel = page.locator("[data-sidebar-right-session]");
  const grid = panel.getByRole("group", { name: locale === "zh" ? "工作区工具" : "Workspace tools", exact: true });
  const label = (en: string, zh: string) => locale === "zh" ? zh : en;
  try {
    await page.goto(bridge.url);
    await page.getByRole("button", { name: label("Open right sidebar", "打开右侧边栏"), exact: true }).click();
    await expect(panel.getByText(/^(Workspace tools|工作区工具)$/)).toHaveCount(0);
    await expectTopAlignedGrid(grid, locale, desktop);
    if (width >= 768) {
      await panel.getByRole("button", { name: label("Fullscreen", "全屏"), exact: true }).click();
      await expectTopAlignedGrid(grid, locale, desktop);
      await page.screenshot({ path: testInfo.outputPath(`guide-fullscreen-${width}.png`), animations: "disabled" });
      await panel.getByRole("button", { name: label("Split", "分栏"), exact: true }).click();
      await expect(grid).toHaveCount(2);
      for (const item of await grid.all()) await expectTopAlignedGrid(item, locale, desktop);
      const secondPane = panel.locator('[data-dockkit-pane][data-dockkit-column="1"]');
      await secondPane.getByRole("button", { name: label("Close", "关闭"), exact: true }).click();
      await expect(grid).toHaveCount(1);
      await panel.getByRole("button", { name: label("Exit fullscreen", "退出全屏"), exact: true }).click();
      await expectTopAlignedGrid(grid, locale, desktop);
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
    await expectTopAlignedGrid(grid, locale, desktop);
    if (desktop) {
      const preview = grid.getByRole("button", { name: "Web Preview", exact: true });
      const icon = await preview.locator("svg").first().innerHTML();
      const cue = preview.locator("svg").last().locator("..");
      await expect(cue).toHaveCSS("opacity", "0");
      await preview.hover();
      await expect(cue).toHaveCSS("opacity", "1");
      await page.mouse.move(2, 2);
      await expect(cue).toHaveCSS("opacity", "0");
      await grid.getByRole("button", { name: "Git changes", exact: true }).focus();
      await page.keyboard.press("Tab");
      await expect(preview).toBeFocused();
      await expect(preview).toHaveCSS("outline-width", "2px");
      await expect(cue).toHaveCSS("opacity", "1");
      await page.keyboard.press("Enter");
      const previewPanel = panel.getByRole("region", { name: "Web Preview" });
      await expect(previewPanel.getByRole("textbox", { name: "Search or enter a URL" })).toBeVisible();
      expect(await previewPanel.locator('[data-web-preview-state="idle"] svg').first().innerHTML()).toBe(icon);
      await expect(grid).toHaveCount(0);
    }
    expect(errors).toEqual([]);
  } finally {
    try { if (!page.isClosed()) await page.goto("about:blank"); }
    finally { await bridge.close(); await rm(directory, { recursive: true, force: true }); }
  }
});

test("hosted launchers use their declared category and hide only decorative art in a narrow pane", async ({ page }, testInfo) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-guide-design-"));
  const { host } = terminalHost(directory);
  const active = { official: true, installed: true, enabled: true, generation: 1, phase: "active", documentUrl: "/launcher-fixture.html", controllerUrl: "/launcher-fixture.html" };
  const cards: HostedPluginCard[] = OFFICIAL_ENTRIES.map(({ id, name, icon, policy }) => ({ ...active, pluginId: id, name, icon, contribution: policy.contribution }));
  const legacy = cards[0]!.contribution!;
  cards.push({ ...active, official: false, pluginId: "fixture-legacy", name: "Legacy Tool", contribution: { ...legacy, entry: { ...legacy.entry, label: "Legacy Tool", category: undefined } } });
  host.hosted = { ...emptyHosted, inventory: async () => ({ plugins: cards }), views: async () => ({ viewToken: "launcher-fixture", commands: [] }) };
  const bridge = await startBridge(host, fileURLToPath(new URL("../../web/dist/", import.meta.url)), new NodeTelemetry({ env: { PI_WEB_SENTRY_ENABLED: "false" }, monitor: false }), { pluginSettingsFile: join(directory, "plugins.json") });
  try {
    await page.route("**/launcher-fixture.html?*", route => route.fulfill({ contentType: "text/html", body: `<!doctype html><script>
      addEventListener('message', ({data, ports}) => {
        if (data?.type !== 'pi:hosted:connect') return;
        const [port] = ports;
        port.onmessage = ({data}) => port.postMessage({type: 'response', id: data.id, ok: true});
      });
    </script>` }));
    await page.addInitScript(() => localStorage.setItem("pi-web-locale", "en"));
    await page.setViewportSize({ width: 1440, height: 1040 });
    await page.goto(bridge.url);
    await page.getByRole("button", { name: "Open right sidebar", exact: true }).click();
    const panel = page.locator("[data-sidebar-right-session]");
    await panel.getByRole("button", { name: "Fullscreen", exact: true }).click();
    await expect(panel.getByRole("heading")).toHaveText(["Workspace", "Drawing & design", "Other tools"]);
    const design = panel.getByRole("group", { name: "Drawing & design", exact: true });
    const [excalidraw, pencil] = ["Excalidraw", "OpenPencil"].map(name => design.getByRole("button", { name, exact: true }));
    await expect(excalidraw!.locator("svg").last()).toBeVisible();
    await expect(pencil!.locator("svg").last()).toBeVisible();
    for (const card of [excalidraw!, pencil!]) await expect(card.locator("svg").last().locator("..")).toHaveCSS("border-top-width", "0px");
    expect((await excalidraw!.boundingBox())?.y).toBe((await pencil!.boundingBox())?.y);
    await expect(panel.getByRole("group", { name: "Other tools", exact: true }).getByRole("button", { name: "Legacy Tool", exact: true })).toBeEnabled();
    await panel.getByRole("group", { name: "Workspace tools", exact: true }).screenshot({ path: testInfo.outputPath("launcher-groups.png"), animations: "disabled" });
    await page.setViewportSize({ width: 320, height: 1040 });
    for (const card of [excalidraw!, pencil!]) {
      await expect(card.locator("svg").first()).toBeVisible();
      await expect(card.locator("svg").last()).toBeHidden();
      await expect(card).toBeInViewport({ ratio: 1 });
    }
    expect((await pencil!.boundingBox())!.y).toBeGreaterThan((await excalidraw!.boundingBox())!.y);
  } finally {
    try { if (!page.isClosed()) await page.goto("about:blank"); }
    finally { await bridge.close(); await rm(directory, { recursive: true, force: true }); }
  }
});
