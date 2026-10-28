import { test, expect } from "@playwright/test";
import { startBridge } from "../../src/host/server/transport/bridge.ts";
import { NodeTelemetry } from "../../src/platform/telemetry/telemetry.ts";
import { terminalHost } from "../helpers/terminal-host.ts";

for (const locale of ["zh", "en"] as const) for (const width of [390, 1440]) test(`reload recovery notice ${locale}/${width}`, async ({ page }, info) => {
  const { host } = terminalHost();
  const bridge = await startBridge(host, new URL("../../web/dist", import.meta.url).pathname, new NodeTelemetry({ env: { PI_WEB_SENTRY_ENABLED: "false" }, monitor: false }));
  const key = "pi:hosted:unconfirmed-views:v1";
  const records = ["controller", "editor"].map((kind, i) => ({ pluginId: "official", generation: 8, sessionId: "terminal-a", mountId: `old-${i}`, viewToken: `token-${i}`, kind }));
  const writes: unknown[] = [];
  try {
    await page.setViewportSize({ width, height: 800 });
    await page.addInitScript(({ locale, records, key }) => {
      localStorage.setItem("pi-web-locale", locale);
      localStorage.setItem("pi-web-theme", "dark");
      if (!sessionStorage.getItem("seeded")) {
        sessionStorage.setItem(key, JSON.stringify(records)); sessionStorage.setItem("seeded", "1");
      }
    }, { locale, records, key });
    let failDiscard = false;
    await page.route("**/api/hosted-plugins/views", async route => {
      const request = route.request().postDataJSON();
      if (request.operation !== "reconcile") writes.push(request);
      const failed = failDiscard && request.operation === "discard";
      await route.fulfill({ status: failed ? 503 : 200, contentType: "application/json", body: JSON.stringify(failed ? { error: "offline" } : { commands: [], recovery: { state: "unconfirmed" } }) });
    });
    await page.goto(bridge.url);
    const notice = page.locator("[data-hosted-recovery]");
    await expect(notice).toBeVisible();
    await expect(notice.locator("summary")).toContainText(locale === "zh" ? "插件草稿待确认（2）" : "Plugin drafts need review (2)");
    await expect(notice).not.toHaveAttribute("open");
    expect(writes).toEqual([]);
    const bounds = await notice.boundingBox();
    expect(bounds!.height).toBeLessThan(70); expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    expect(await notice.evaluate(el => getComputedStyle(el).position)).toBe("fixed");
    await page.screenshot({ path: info.outputPath("recovery-collapsed.png") });
    await notice.locator("summary").click();
    await expect(notice.locator("[data-unconfirmed-view]")).toHaveCount(2);
    await page.screenshot({ path: info.outputPath("recovery-expanded.png") });
    const discard = notice.getByRole("button", { name: locale === "zh" ? "丢弃此视图的未确认记录" : "Discard unconfirmed edits for this view", exact: true }).first();
    page.once("dialog", dialog => dialog.dismiss()); await discard.click();
    expect(writes).toEqual([]);
    failDiscard = true;
    page.once("dialog", dialog => dialog.accept()); await discard.click();
    await expect(notice.getByRole("alert")).toContainText("offline");
    expect(JSON.parse((await page.evaluate(key => sessionStorage.getItem(key), key))!)).toHaveLength(2);
    failDiscard = false;
    page.once("dialog", dialog => dialog.accept()); await discard.click();
    await expect(notice.locator("[data-unconfirmed-view]")).toHaveCount(1);
    expect(writes.at(-1)).toMatchObject({ operation: "discard", viewToken: "token-0", confirmation: "discard-unconfirmed-edits" });
    await page.reload();
    await expect(notice.locator("summary")).toContainText(locale === "zh" ? "（1）" : "(1)");
    await notice.locator("summary").click();
    page.once("dialog", dialog => dialog.accept()); await discard.click();
    await expect(notice).toHaveCount(0);
    expect(JSON.parse((await page.evaluate(key => sessionStorage.getItem(key), key))!)).toEqual([]);
  } finally { await bridge.close(); }
});
