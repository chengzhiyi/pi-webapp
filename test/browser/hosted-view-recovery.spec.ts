import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { boxes, hostedParity } from "../helpers/hosted-parity.ts";

test.beforeEach(() => {
  test.skip(!process.env.HOSTED_EXCALIDRAW_TGZ, "Explicit independently packaged plugin archive required");
  test.setTimeout(100_000);
});

// Actual built App, authenticated bridge, SDK session, installed plugin archive and
// worker. The registry/provider are deterministic local transports; view RPCs and
// native editor/local backups are real. No flush or save acknowledgement is mocked.
test("refresh with only a hidden controller does not block independent update, disable or uninstall", async ({ page }, info) => {
  const h = await hostedParity(page);
  try {
    await page.goto(h.bridge.url);
    await expect(page.locator('iframe[title="Excalidraw controller"]')).toBeAttached();
    await expect.poll(() => [...(h.integration as any).views.values()].flatMap((c: any) => [...c.views.values()]).every((view: any) => !view.busy)).toBe(true);
    for (let count = 0; count < 2; count++) {
      await page.reload();
      await expect(page.locator('iframe[title="Excalidraw controller"]')).toBeAttached();
      await expect(page.locator("[data-unconfirmed-view]")).toHaveCount(0);
      await expect.poll(() => [...(h.integration as any).views.values()].flatMap((c: any) => [...c.views.values()]).length).toBe(1);
    }
    expect(await page.locator('iframe[title="Excalidraw editor"]').count()).toBe(0);
    const generation = (await h.card()).generation!;
    h.upgrade(); await h.manage("update");
    await expect.poll(async () => (await h.card()).generation).toBe(generation + 1);
    await h.manage("disable"); expect((await h.card()).enabled).toBe(false);
    await h.manage("enable"); expect((await h.card()).enabled).toBe(true);
    await h.manage("uninstall"); expect((await h.card()).installed).toBe(false);
    expect(h.sessions.session).toBe(h.retained);
    expect(h.errors).toEqual([]); expect(h.external).toEqual([]);
    await info.attach("controller-refresh-lifecycle", { body: JSON.stringify({ generationBefore: generation, final: await h.card(), retainedSdk: true }), contentType: "application/json" });
  } finally { await h.close(); }
});

test("lost dirty editor has a real downloadable recovery copy and explicit retention unblocks lifecycle without restoring over winning data", async ({ page }, info) => {
  const h = await hostedParity(page);
  page.on("dialog", dialog => { void dialog.accept(); });
  try {
    const drawing = await h.tool("excalidraw_create_view", boxes());
    await page.goto(h.bridge.url); const editor = await h.open();
    await expect.poll(async () => (await h.action("get", { id: drawing.id })).scene.appState.scrollX ?? 0).not.toBe(0);
    const before = await h.action("get", { id: drawing.id });
    await page.context().route("**/api/hosted-plugins/action", async route => {
      if (route.request().postDataJSON()?.action === "sync") await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Injected checkpoint connection loss" }) });
      else await route.continue();
    });
    await editor.locator("canvas.interactive").click(); await page.keyboard.press("ControlOrMeta+a"); await page.keyboard.press("ArrowRight"); await page.keyboard.press("Escape");
    const backupKey = `pi-diagram:${h.sessionId}:${drawing.id}`;
    await expect.poll(() => page.evaluate(key => {
      const raw = localStorage.getItem(key); return raw ? JSON.parse(raw).elements[0]?.x : null;
    }, backupKey)).not.toBe(before.scene.elements[0].x);
    const localDraft = await page.evaluate(key => localStorage.getItem(key)!, backupKey);
    await expect.poll(() => [...(h.integration as any).views.values()].flatMap((c: any) => [...c.views.values()]).some((view: any) => view.kind === "editor" && view.dirty)).toBe(true);
    await page.reload();
    await page.getByRole("button", { name: "Plugins", exact: true }).click();
    await page.locator("[data-hosted-recovery]").getByRole("button").click();
    const recoveries = page.locator("[data-unconfirmed-view]");
    await expect(recoveries.filter({ has: page.getByRole("heading", { name: /^Editor/ }) })).toBeVisible();
    const priorEditor = recoveries.filter({ has: page.getByRole("heading", { name: /^Editor/ }) });
    const download = page.waitForEvent("download");
    await priorEditor.getByRole("button", { name: /Download local recovery copy/ }).click();
    const exported = await download; const recovered = await readFile((await exported.path())!, "utf8");
    expect(JSON.parse(recovered).elements).toEqual(JSON.parse(localDraft).elements);
    // The file came from the actual old editor's local backup, not a fabricated
    // post-refresh model or an earlier backend checkpoint.
    expect(JSON.parse(recovered).elements[0].x).not.toBe(before.scene.elements[0].x);
    await page.context().unroute("**/api/hosted-plugins/action");
    await expect.poll(async () => (await h.action("get", { id: drawing.id })).scene.elements).toEqual(before.scene.elements);
    const retain = page.getByRole("button", { name: "Retain recovery record and unblock", exact: true });
    while (await retain.count()) {
      const count = await retain.count(); await retain.first().click();
      await page.getByRole("dialog", { name: "Retain this view for recovery?", exact: true }).getByRole("button", { name: "Retain record", exact: true }).click();
      await expect(retain).toHaveCount(count - 1);
    }
    await expect(recoveries.filter({ hasText: "recovery record retained" }).first()).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Hosted test", exact: true }).click();
    const generation = (await h.card()).generation!;
    h.upgrade(); await h.manage("update", { reopenEditors: true });
    expect((await h.card()).generation).toBe(generation + 1);
    expect((await h.action("get", { id: drawing.id })).scene.elements).toEqual(before.scene.elements);
    expect(JSON.parse(recovered).elements).toEqual(JSON.parse(localDraft).elements);
    // The management response commits the worker before the browser has mounted
    // its new-generation tool preview. Wait for actual client initialization and
    // its server-side readiness report; a still-busy view must remain protected.
    await expect(page.locator('iframe[title="Excalidraw tool"]')).toHaveAttribute("src", new RegExp(`[?&]generation=${generation + 1}(?:&|$)`));
    await expect(page.frameLocator('iframe[title="Excalidraw tool"]').getByRole("img")).toBeVisible();
    await expect.poll(() => [...(h.integration as any).views.values()].every((coordinator: any) =>
      [...coordinator.views.values()].every((view: any) =>
        (view.kind === "controller" || view.initialized) && !view.busy && !view.activeActions))).toBe(true);
    await h.manage("disable"); await h.manage("uninstall");
    expect((await h.card()).installed).toBe(false);
    expect(h.errors).toEqual([]); expect(h.external).toEqual([]);
    await info.attach("retained-editor-recovery", { body: JSON.stringify({ generationBefore: generation, recoveredElements: JSON.parse(recovered).elements, winningElements: before.scene.elements, sameSdkSession: h.sessions.session === h.retained }), contentType: "application/json" });
  } finally { await page.context().unroute("**/api/hosted-plugins/action"); await h.close(); }
});
