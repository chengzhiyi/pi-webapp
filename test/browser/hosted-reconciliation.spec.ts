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
    const dialog = page.getByRole("dialog", { name: t("检查之前的插件视图", "Review previous plugin views"), exact: true });
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

test("recovery includes other sessions without opening their drawing in the current session", async ({ page }) => {
  const { host } = terminalHost();
  const bridge = await startBridge(host, new URL("../../web/dist", import.meta.url).pathname);
  const record = { pluginId: "@chengzhiyi/pi-excalidraw", generation: 8, sessionId: "terminal-b", mountId: "other-session-editor", viewToken: "other-session-token", kind: "editor", contentId: "other-drawing", frameStarted: true };
  try {
    await page.addInitScript(record => {
      localStorage.setItem("pi-web-locale", "en");
      sessionStorage.setItem("pi:hosted:unconfirmed-views:v1", JSON.stringify([record]));
    }, record);
    await page.route("**/api/hosted-plugins/views", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ commands: [], recovery: { state: "unconfirmed" } }) }));
    await page.goto(bridge.url);
    await page.getByRole("button", { name: "Plugins", exact: true }).click();
    await page.locator("[data-hosted-recovery]").getByRole("button").click();
    const dialog = page.getByRole("dialog", { name: "Review previous plugin views", exact: true });
    await expect(dialog.locator("[data-unconfirmed-view]")).toHaveCount(1);
    await expect(dialog.getByRole("button", { name: "Retain recovery record and unblock", exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Open drawing and compare backup", exact: true })).toHaveCount(0);
  } finally { await page.close(); await bridge.close(); }
});

test("a newly opened window exposes a durable drawing recovery copy and waits for explicit retention", async ({ page, context }) => {
  const { host } = terminalHost();
  const bridge = await startBridge(host, new URL("../../web/dist", import.meta.url).pathname);
  const record = { pluginId: "@chengzhiyi/pi-excalidraw", generation: 8, sessionId: "terminal-b", mountId: "closed-window-editor", viewToken: "closed-window-token", kind: "editor", contentId: "lost-drawing", frameStarted: true };
  const scene = JSON.stringify({ type: "excalidraw", elements: [{ id: "unsynced-shape", x: 37 }] });
  const operations: Record<string, unknown>[] = [];
  let reopened: typeof page | undefined;
  try {
    await context.route("**/api/hosted-plugins/views", async route => {
      const body = route.request().postDataJSON(); operations.push(body);
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ commands: [], recovery: { state: body.operation === "recover" ? "retained" : "unconfirmed" } }) });
    });
    await page.goto(bridge.url);
    await page.evaluate(({ record, scene }) => {
      localStorage.setItem("pi-web-locale", "en");
      localStorage.setItem(`pi:hosted:unconfirmed-view:v1:${record.viewToken}`, JSON.stringify(record));
      localStorage.setItem(`pi-diagram:${record.sessionId}:${record.contentId}`, scene);
    }, { record, scene });
    await page.close();
    reopened = await context.newPage(); await reopened.goto(bridge.url);
    await reopened.getByRole("button", { name: "Plugins", exact: true }).click();
    await reopened.locator("[data-hosted-recovery]").getByRole("button").click();
    const dialog = reopened.getByRole("dialog", { name: "Review previous plugin views", exact: true });
    await expect(dialog.locator("[data-unconfirmed-view]")).toHaveCount(1);
    expect(operations).toEqual([]);
    const download = reopened.waitForEvent("download");
    await dialog.getByRole("button", { name: /Download local recovery copy/ }).click();
    const exported = await download;
    const chunks: Buffer[] = [];
    for await (const chunk of (await exported.createReadStream())!) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe(scene);
    await dialog.getByRole("button", { name: "Retain recovery record and unblock", exact: true }).click();
    const confirmation = reopened.getByRole("dialog", { name: "Retain this view for recovery?", exact: true });
    expect(operations).toEqual([]);
    await confirmation.getByRole("button", { name: "Retain record", exact: true }).click();
    await expect(dialog.getByText(/Disconnected view recovery record retained/)).toBeVisible();
    expect(operations).toEqual([expect.objectContaining({ operation: "recover", viewToken: record.viewToken, confirmation: "retain-unconfirmed-edits" })]);
  } finally { await reopened?.close(); if (!page.isClosed()) await page.close(); await bridge.close(); }
});
