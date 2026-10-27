import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { boxes, hostedParity } from "../helpers/hosted-parity.ts";

test("ORI-39 A04/A21: packed real v1 plan extension command, UI approval and v2 install cannot expand plan/allowlist", async ({ page }, info) => {
  test.skip(!process.env.HOSTED_EXCALIDRAW_TGZ || !process.env.HOSTED_PLAN_V1_TGZ, "Both independently packed archives required");
  test.setTimeout(100_000);
  let allowlist: readonly string[] | undefined;
  const h = await hostedParity(page, { v1Archive: process.env.HOSTED_PLAN_V1_TGZ!, installDrawing: false, policy: () => ({ allowlist }) });
  const lastDenial = () => h.retained.messages.filter(m => m.role === "toolResult" && m.toolName === "excalidraw_create_view").at(-1) as any;
  try {
    expect(h.sessions.catalog!.ids()).toEqual(["@chengzhiyi/pi-plan-mode"]);
    expect(h.sessions.catalog!.errors).toEqual([]);
    // Dispatch the real registered command through the retained SDK, not an imitation factory.
    await h.retained.prompt("/plan on");
    await page.goto(h.bridge.url);
    await expect(page.getByRole("button", { name: "Plan mode on, press to turn off", exact: true })).toBeVisible();
    const pending = h.tool("submit_plan", { title: "ORI-39 local verification only", markdown: "Read local files and verify compatibility. Do not publish, push or change the parent checkout." });
    await expect(page.locator("[data-plan-review-key]")).toBeVisible();
    await page.locator("[data-plan-review-key]").getByRole("button", { name: /Approve/ }).click();
    await pending;
    expect(h.sessions.snapshot().pluginEntries.some(entry => entry.kind.endsWith("/execution") && (entry.data as any).outcome === "completed")).toBe(true);
    await expect(page.getByRole("button", { name: "Plan mode on, press to turn off", exact: true })).toBeVisible();
    const boot = await page.evaluate(() => ((window as any).__ori39Boot = crypto.randomUUID()));
    await page.getByRole("button", { name: "Plugins", exact: true }).click();
    const manager = page.locator("[data-hosted-management]");
    await expect(manager).toContainText("Not installed");
    await manager.getByRole("button", { name: "Download", exact: true }).click(); await expect(manager).toContainText("Installed · Disabled");
    await manager.getByRole("switch", { name: "Enable Excalidraw", exact: true }).click(); await expect(manager).toContainText("Installed · Enabled");
    h.retained.setActiveToolsByName(["excalidraw_create_view", "diagram_read", "submit_plan"]);
    await h.tool("excalidraw_create_view", boxes(), true);
    expect(h.retained.getAllTools().some(tool => tool.name === "excalidraw_create_view")).toBe(true);
    expect(h.retained.getActiveToolNames()).not.toContain("excalidraw_create_view");
    expect(JSON.stringify(lastDenial().content)).toContain("Tool excalidraw_create_view not found");
    expect(await h.action("list")).toEqual([]);
    // The real v1 browser action leaves plan mode, but the host's empty allowlist still denies
    // an old definition deliberately reactivated by the extension/SDK caller.
    await page.getByRole("button", { name: "Hosted test", exact: true }).click();
    await page.getByRole("button", { name: "Plan mode on, press to turn off", exact: true }).click();
    await expect.poll(() => (h.sessions.snapshot().pluginEntries.filter(entry => entry.kind.endsWith("/state")).at(-1)?.data as any)?.enabled).toBe(false);
    allowlist = [];
    h.retained.setActiveToolsByName(["excalidraw_create_view", "diagram_read", "submit_plan"]);
    await h.tool("excalidraw_create_view", boxes(), true);
    expect(JSON.stringify(lastDenial().content)).toContain("host policy");
    expect(await h.action("list")).toEqual([]);
    expect(h.sessions.session).toBe(h.retained); expect(await page.evaluate(() => (window as any).__ori39Boot)).toBe(boot);
    expect(h.errors).toEqual([]); expect(h.external).toEqual([]);
    const archive = await readFile(process.env.HOSTED_PLAN_V1_TGZ!);
    await info.attach("v1-provenance-and-plan-entries", { body: JSON.stringify({ sha256: createHash("sha256").update(archive).digest("hex"), entries: h.sessions.snapshot().pluginEntries, tools: h.retained.getAllTools().map(t => ({ name: t.name, exposure: t.exposure })) }), contentType: "application/json" });
  } finally { await h.close(); }
});
