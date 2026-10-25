import { test, expect, chromium } from "@playwright/test";
import { readFile, writeFile, rm } from "node:fs/promises";
import { hostedParity, boxes } from "../helpers/hosted-parity.ts";

test("diagnostic: HTTP/1.1 socket-pool evidence for the legacy per-view long polls", async ({}, info) => {
  test.skip(!process.env.HOSTED_TRANSPORT_DIAGNOSE_LEGACY || !process.env.HOSTED_EXCALIDRAW_TGZ, "Explicit baseline diagnostic only");
  test.setTimeout(100_000);
  const netlog = info.outputPath("netlog-private.json");
  const browser = await chromium.launch({ args: [`--log-net-log=${netlog}`] });
  const context = await browser.newContext(); const page = await context.newPage();
  const h = await hostedParity(page);
  try {
    await h.tool("excalidraw_create_view", boxes()); await page.goto(h.bridge.url); await h.open();
    const second = await context.newPage(); await second.goto(h.bridge.url);
    const img = second.frameLocator('iframe[title="Excalidraw tool"]').first().getByRole("img");
    await expect(img).not.toBeVisible();
    await new Promise(resolve => setTimeout(resolve, 3000)); await expect(img).not.toBeVisible();
    // Cancel first window's sockets, not server registrations or acknowledgements.
    const releasedAt = Date.now(); await page.close(); await expect(img).toBeVisible({ timeout: 3000 });
    await info.attach("release-first-window", { body: JSON.stringify({ unblockedMs: Date.now() - releasedAt }), contentType: "application/json" });
  } finally { await h.close(); await browser.close(); }
  const log = JSON.parse(await readFile(netlog, "utf8")); await rm(netlog);
  const names = Object.fromEntries(Object.entries(log.constants.logEventTypes).map(([k, v]) => [String(v), k]));
  // Store only non-header, non-URL socket pool evidence; raw netlog is not a deliverable.
  const events = log.events.filter((e: any) => /SOCKET_POOL_STALLED|SOCKET_POOL_BOUND_TO_SOCKET|TCP_CONNECT$/.test(names[e.type] ?? "")).map((e: any) => ({ time: e.time, type: names[e.type], phase: e.phase, source: e.source, params: Object.fromEntries(Object.entries(e.params ?? {}).filter(([k]) => ["group_id", "source_dependency", "address_list"].includes(k))) }));
  const summary = info.outputPath("socket-pool-summary.json"); await writeFile(summary, JSON.stringify(events, null, 2)); await info.attach("socket-pool-summary", { path: summary, contentType: "application/json" });
  expect(events.some((e: any) => /STALLED/.test(e.type))).toBe(true);
});

test("aggregate transport keeps same-profile windows and repeated SDK tool-result frames responsive", async ({ page }, info) => {
  test.skip(!process.env.HOSTED_EXCALIDRAW_TGZ, "Explicit archive required"); test.setTimeout(100_000);
  const h = await hostedParity(page);
  try {
    await h.tool("excalidraw_create_view", boxes()); await page.goto(h.bridge.url); await h.open();
    const second = await page.context().newPage(); await second.goto(h.bridge.url); await h.open(second);
    const boot = await page.evaluate(() => ((window as any).__transportBoot = crypto.randomUUID()));
    for (let i = 0; i < 3; i++) await h.tool("excalidraw_create_view", { ...boxes(2), title: `Additional ${i}` });
    await expect(page.locator('iframe[title="Excalidraw tool"]')).toHaveCount(4);
    for (const target of [page, second]) {
      await expect(target.locator('iframe[title="Excalidraw tool"]')).toHaveCount(4);
      for (let i = 0; i < 4; i++) {
        // Thumbnails intentionally initialize only when their iframe is in view.
        await target.locator('iframe[title="Excalidraw tool"]').nth(i).scrollIntoViewIfNeeded();
        await expect(target.frameLocator('iframe[title="Excalidraw tool"]').nth(i).getByRole("img")).toBeVisible();
      }
    }
    expect(await page.evaluate(() => (window as any).__transportBoot)).toBe(boot);
    const timings = await page.evaluate(() => performance.getEntriesByType("resource").filter(e => e.name.endsWith("/views")).map(e => ({ duration: e.duration })));
    await info.attach("aggregate-poll-timing", { body: JSON.stringify(timings), contentType: "application/json" });
    expect(h.errors).toEqual([]); expect(h.external).toEqual([]);
  } finally { await h.close(); }
});
