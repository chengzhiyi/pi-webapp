import { test, expect } from "@playwright/test";
import { boxes, hostedParity, pluginId } from "../helpers/hosted-parity.ts";

const journal = "pi:hosted:unconfirmed-views:v1";

test("repeated real reload keeps recovery out of layout and preserves drawing checkpoints during resize", async ({ page }, info) => {
  test.skip(!process.env.HOSTED_EXCALIDRAW_TGZ, "Explicit archive required");
  test.setTimeout(90_000);
  const h = await hostedParity(page, { locale: "zh" });
  const lost: any[] = [];
  try {
    const drawing = await h.tool("excalidraw_create_view", boxes());
    await page.goto(h.bridge.url); const editor = await h.open();
    await expect.poll(async () => (await h.action("get", { id: drawing.id })).scene.appState.zoom?.value).toBe(1);
    await editor.locator("canvas.interactive").click(); await page.keyboard.press("ControlOrMeta+a"); await page.keyboard.press("ArrowRight"); await page.keyboard.press("Escape");
    await expect.poll(async () => (await h.action("get", { id: drawing.id })).scene.elements[0].x).not.toBe(0);
    const before = (await h.action("get", { id: drawing.id })).scene.elements;
    for (let attempt = 0; attempt < 3; attempt++) {
      lost.push(...await page.evaluate(key => JSON.parse(sessionStorage.getItem(key) ?? "[]"), journal));
      await page.reload();
      await expect(page.locator("[data-hosted-recovery]")).toHaveCount(1);
      await expect(page.locator("[data-unconfirmed-view]")).toHaveCount(0);
      await expect(page.frameLocator('iframe[title="Excalidraw tool"]').getByRole("img")).toBeVisible();
      const layout = await page.locator("div:has(> [data-shell-overlay])").boundingBox();
      expect(layout!.y).toBe(0); expect(layout!.height).toBe(1000);
      expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1 && document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    }
    await page.getByRole("button", { name: "Pi 设置", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Pi 设置", exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath("reload-settings.png") });
    await page.keyboard.press("Escape");
    const handle = (await page.locator('[data-side="sidebar"]').boundingBox())!;
    await page.mouse.move(handle.x + handle.width / 2, 400); await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2 + 60, 400, { steps: 8 }); await page.mouse.up();
    expect((await page.locator("div:has(> [data-shell-overlay])").boundingBox())!.width).toBe(1440);
    for (const width of [390, 1024, 1440]) {
      await page.setViewportSize({ width, height: 844 });
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1 && document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await expect.poll(async () => (await page.locator("div:has(> [data-shell-overlay])").boundingBox())!.width).toBe(width);
      expect((await page.locator("div:has(> [data-shell-overlay])").boundingBox())!.height).toBe(844);
    }
    expect((await h.action("get", { id: drawing.id })).scene.elements).toEqual(before);
    expect(h.errors).toEqual([]);
  } finally {
    // These are the fixture's departed documents, not the current mounted realms.
    // Explicit cleanup exercises normal recovery authorization; no fake clean ACK.
    for (const item of new Map(lost.map(item => [item.viewToken, item])).values()) {
      const reply = await h.integration.handlers.views({ ...item, operation: "reconcile" });
      if ((reply as any).recovery !== "closed") await h.integration.handlers.views({ ...item, operation: "discard", confirmation: "discard-unconfirmed-edits" });
    }
    await h.close();
  }
});

for (const [width, locale, theme] of [[320, "zh", "dark"], [1440, "en", "light"]] as const) test(`many recovery entries stay bounded and discard requires an explicit per-view confirmation (${width}/${locale})`, async ({ page }, info) => {
  test.skip(!process.env.HOSTED_EXCALIDRAW_TGZ, "Explicit archive required");
  test.setTimeout(90_000);
  const h = await hostedParity(page, { width, locale, theme });
  let pending: any;
  try {
    await h.tool("excalidraw_create_view", boxes());
    const generation = (await h.card()).generation!;
    const record = async (mountId: string) => {
      const base = { pluginId, generation, sessionId: h.sessionId, mountId };
      const { viewToken } = await h.integration.handlers.views({ ...base, operation: "register", kind: "tool" }) as any;
      return { ...base, viewToken, kind: "tool" };
    };
    const closed = await record("confirmed-closed");
    await h.integration.handlers.views({ ...closed, operation: "change", dirty: false, busy: false });
    await h.integration.handlers.views({ ...closed, operation: "close" });
    pending = await record("unconfirmed-draft");
    const unknown = Array.from({ length: 19 }, (_, index) => ({ ...pending, mountId: `unknown-${index}`, viewToken: `unknown-${index}` }));
    await page.addInitScript(({ key, records }) => { if (location.protocol === "http:") sessionStorage.setItem(key, JSON.stringify(records)); }, { key: journal, records: [closed, pending, ...unknown] });
    const operations: string[] = [];
    let rejectDiscard = false;
    await page.route("**/api/hosted-plugins/views", route => {
      const input = route.request().postDataJSON(); operations.push(input.operation);
      return rejectDiscard && input.operation === "discard" ? route.fulfill({ status: 503, json: { error: "Fixture recovery offline" } }) : route.continue();
    });
    await page.goto(h.bridge.url);
    const trigger = page.getByRole("button", { name: locale === "zh" ? "插件视图恢复 · 20" : "Plugin view recovery · 20", exact: true });
    await expect(trigger).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1)).toBe(true);
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: locale === "zh" ? "检查刷新前的插件视图" : "Review previous plugin views", exact: true });
    await expect(dialog.locator("[data-unconfirmed-view]")).toHaveCount(20);
    await expect(dialog.locator('[data-unconfirmed-view="confirmed-closed"]')).toHaveCount(0);
    const bounds = (await dialog.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    expect(bounds.y).toBeGreaterThanOrEqual(0); expect(bounds.y + bounds.height).toBeLessThanOrEqual(1000);
    await page.screenshot({ path: info.outputPath("recovery-list.png") });
    const discard = dialog.locator('[data-unconfirmed-view="unconfirmed-draft"]').getByRole("button");
    await discard.click();
    const confirm = page.getByRole("dialog", { name: locale === "zh" ? "丢弃此视图的未确认修改？" : "Discard this view's unconfirmed edits?", exact: true });
    expect(operations).not.toContain("discard");
    await confirm.getByRole("button", { name: locale === "zh" ? "取消" : "Cancel", exact: true }).click();
    await expect(discard).toBeFocused();
    rejectDiscard = true;
    await discard.click(); await confirm.getByRole("button", { name: locale === "zh" ? "确认丢弃" : "Discard edits", exact: true }).click();
    await expect(dialog.getByRole("alert")).toBeVisible();
    await expect(dialog.locator("[data-unconfirmed-view]")).toHaveCount(20);
    rejectDiscard = false;
    await discard.click(); await confirm.getByRole("button", { name: locale === "zh" ? "确认丢弃" : "Discard edits", exact: true }).click();
    await expect(dialog.locator("[data-unconfirmed-view]")).toHaveCount(19);
    pending = null;
    await page.keyboard.press("Escape"); await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(h.errors).toEqual([]);
  } finally {
    if (pending) await h.integration.handlers.views({ ...pending, operation: "discard", confirmation: "discard-unconfirmed-edits" });
    await h.close();
  }
});
