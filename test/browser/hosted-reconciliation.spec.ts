import { test, expect } from "@playwright/test";
import { startBridge } from "../../src/host/server/transport/bridge.ts";
import { NodeTelemetry } from "../../src/platform/telemetry/telemetry.ts";
import { terminalHost } from "../helpers/terminal-host.ts";

for (const locale of ["zh", "en"] as const) for (const width of [390, 1440]) test(`reload recovery notice ${locale}/${width}`, async ({ page }, info) => {
  const { host } = terminalHost();
  const bridge = await startBridge(host, new URL("../../web/dist", import.meta.url).pathname, new NodeTelemetry({ env: { PI_WEB_SENTRY_ENABLED: "false" }, monitor: false }));
  const key = "pi:hosted:unconfirmed-views:v1";
  const records = ["controller", "editor"].map((kind, i) => ({ pluginId: "official", generation: 8, sessionId: "terminal-a", mountId: `old-${i}`, viewToken: `token-${i}`, kind }));
  const writes: unknown[] = [], t = (zh: string, en: string) => locale === "zh" ? zh : en;
  try {
    await page.setViewportSize({ width, height: 800 });
    await page.addInitScript(({ locale, records, key }) => {
      localStorage.setItem("pi-web-locale", locale); localStorage.setItem("pi-web-theme", "dark");
      if (!sessionStorage.getItem("seeded")) { sessionStorage.setItem(key, JSON.stringify(records)); sessionStorage.setItem("seeded", "1"); }
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
    await expect(notice).toHaveCount(0);
    await page.getByRole("button", { name: t("插件", "Plugins"), exact: true }).click();
    const trigger = notice.getByRole("button");
    await expect(trigger).toContainText("2"); expect(writes).toEqual([]);
    const bounds = (await notice.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    expect(await notice.evaluate(el => getComputedStyle(el).position)).not.toBe("fixed");
    await page.screenshot({ path: info.outputPath("recovery-collapsed.png") });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: t("检查刷新前的插件视图", "Review previous plugin views"), exact: true });
    await expect(dialog.locator("[data-unconfirmed-view]")).toHaveCount(2);
    await page.screenshot({ path: info.outputPath("recovery-expanded.png") });
    const discard = dialog.getByRole("button", { name: t("丢弃此视图的未确认修改", "Discard this view's unconfirmed edits"), exact: true }).first();
    const confirm = page.getByRole("dialog", { name: t("丢弃此视图的未确认修改？", "Discard this view's unconfirmed edits?"), exact: true });
    await discard.click(); await confirm.getByRole("button", { name: t("取消", "Cancel"), exact: true }).click();
    expect(writes).toEqual([]);
    failDiscard = true;
    await discard.click(); await confirm.getByRole("button", { name: t("确认丢弃", "Discard edits"), exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("offline");
    expect(JSON.parse((await page.evaluate(key => sessionStorage.getItem(key), key))!)).toHaveLength(2);
    failDiscard = false;
    await discard.click(); await confirm.getByRole("button", { name: t("确认丢弃", "Discard edits"), exact: true }).click();
    await expect(dialog.locator("[data-unconfirmed-view]")).toHaveCount(1);
    expect(writes.at(-1)).toMatchObject({ operation: "discard", viewToken: "token-0", confirmation: "discard-unconfirmed-edits" });
    await page.reload();
    await page.getByRole("button", { name: t("插件", "Plugins"), exact: true }).click();
    await expect(trigger).toContainText("1"); await trigger.click();
    await discard.click(); await confirm.getByRole("button", { name: t("确认丢弃", "Discard edits"), exact: true }).click();
    await expect(notice).toHaveCount(0);
    expect(JSON.parse((await page.evaluate(key => sessionStorage.getItem(key), key))!)).toEqual([]);
  } finally { await page.close(); await bridge.close(); }
});
