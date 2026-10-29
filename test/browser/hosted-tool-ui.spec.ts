import { test, expect } from "@playwright/test";
import { boxes, hostedParity } from "../helpers/hosted-parity.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

for (const [width, theme] of [[1440, "light"], [390, "dark"]] as const) test(`host tool card collapses and parameters stay page-level at ${width}/${theme}`, async ({ page }, info) => {
  test.skip(!process.env.HOSTED_EXCALIDRAW_TGZ, "Explicit independently built archive required");
  test.setTimeout(90_000);
  const h = await hostedParity(page, { width, theme });
  try {
    await h.tool("excalidraw_create_view", boxes(30));
    await page.goto(h.bridge.url);
    const card = page.locator("[data-hosted-tool-card]");
    await expect(card).toBeVisible();
    const toggle = card.getByRole("button", { name: "Toggle preview", exact: true });
    const preview = page.frameLocator('iframe[title="Excalidraw tool"]');
    await expect(preview.getByRole("img")).toBeVisible();
    const arrow = toggle.locator("svg"), buttonBounds = (await toggle.boundingBox())!, arrowBounds = (await arrow.boundingBox())!;
    expect(Math.abs(arrowBounds.y + arrowBounds.height / 2 - buttonBounds.y - buttonBounds.height / 2)).toBeLessThanOrEqual(1);
    const source = await page.locator('iframe[title="Excalidraw tool"]').getAttribute("src");
    for (let i = 0; i < 3; i++) {
      await toggle.click(); await expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect((await card.boundingBox())!.height).toBeLessThan(85);
      if (i === 0) await page.screenshot({ path: info.outputPath("collapsed.png") });
      await toggle.click(); await expect(preview.getByRole("img")).toBeVisible();
      await expect.poll(async () => (await card.boundingBox())!.height).toBeGreaterThan(150);
      if (i === 0) await page.screenshot({ path: info.outputPath("expanded.png") });
    }
    expect(await page.locator('iframe[title="Excalidraw tool"]').getAttribute("src")).toBe(source);
    const parameters = card.getByRole("button", { name: "View parameters", exact: true });
    await parameters.click();
    const dialog = page.getByRole("dialog", { name: "Tool parameters", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("pre").first()).toContainText("box-29");
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    const bounds = (await dialog.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    expect(bounds.y).toBeGreaterThanOrEqual(0); expect(bounds.y + bounds.height).toBeLessThanOrEqual(1000);
    const scroll = await dialog.locator("[data-tool-parameters]").evaluate(e => ({ client: e.clientHeight, scroll: e.scrollHeight }));
    expect(scroll.scroll).toBeGreaterThan(scroll.client);
    const close = dialog.getByRole("button", { name: "Close", exact: true });
    await expect(close).toBeFocused();
    await page.keyboard.press("Shift+Tab"); await expect(dialog.locator("pre").last()).toBeFocused();
    await page.keyboard.press("Tab"); await expect(close).toBeFocused();
    // Programmatic focus escape is contained too, not only ordinary Tab cycling.
    await toggle.evaluate(element => element.focus()); await expect(close).toBeFocused();
    await page.screenshot({ path: info.outputPath("parameters.png") });
    await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0); await expect(parameters).toBeFocused();
    await parameters.click(); await close.click(); await expect(parameters).toBeFocused();
    expect(h.errors).toEqual([]); expect(h.external).toEqual([]);
  } finally { await h.close(); }
});

test("native Chinese editing and repeated enable/dispose leave no host dialogs or focus listeners", async ({ page }, info) => {
  test.skip(!process.env.HOSTED_EXCALIDRAW_TGZ, "Explicit independently built archive required");
  test.setTimeout(100_000);
  const consoleErrors: string[] = [];
  page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
  // Observe host listeners only; every iframe has its own document and realm.
  await page.addInitScript(() => {
    const add = document.addEventListener.bind(document), remove = document.removeEventListener.bind(document);
    const listeners = new Map<string, Set<unknown>>([["keydown", new Set()], ["focusin", new Set()]]);
    document.addEventListener = ((type: string, listener: unknown, options: any) => {
      if (["keydown", "focusin"].includes(type)) { const set = listeners.get(type) ?? new Set(); set.add(listener); listeners.set(type, set); }
      add(type, listener as EventListener, options);
    }) as typeof document.addEventListener;
    document.removeEventListener = ((type: string, listener: unknown, options: any) => { listeners.get(type)?.delete(listener); remove(type, listener as EventListener, options); }) as typeof document.removeEventListener;
    (window as any).__hostFocusListeners = () => [...listeners].map(([type, set]) => [type, set.size]);
  });
  const h = await hostedParity(page);
  try {
    const created = await h.tool("excalidraw_create_view", boxes()); await page.goto(h.bridge.url);
    const editor = await h.open(), canvas = editor.locator("canvas.interactive");
    await canvas.click(); await page.keyboard.press("t");
    await canvas.click({ position: { x: 100, y: 300 } });
    const text = editor.locator("textarea.excalidraw-wysiwyg"); await expect(text).toBeVisible();
    // Text injection plus composition lifecycle are browser-level IME coverage;
    // this does not simulate an OS candidate window.
    await text.dispatchEvent("compositionstart", { data: "中文" });
    await page.keyboard.insertText("中文输入回归");
    await text.dispatchEvent("compositionend", { data: "中文输入回归" });
    await page.keyboard.press("Escape");
    await expect.poll(async () => (await h.action("get", { id: created.id })).scene.elements.some((e: any) => e.text === "中文输入回归")).toBe(true);
    await editor.getByTestId("main-menu-trigger").click(); await editor.getByTestId("help-menu-item").click();
    await expect(editor.getByRole("dialog")).toBeVisible();
    expect(await editor.locator(".Modal").evaluate(e => getComputedStyle(e).position)).toBe("absolute");
    await page.screenshot({ path: info.outputPath("native-help.png") });
    await page.keyboard.press("Escape"); await expect(editor.getByRole("dialog")).toHaveCount(0);
    const collapse = page.getByRole("button", { name: "Collapse right sidebar", exact: true });
    if (await collapse.isVisible()) await collapse.click();
    const listeners = () => page.evaluate(() => (window as any).__hostFocusListeners());
    const before = await listeners();
    for (let i = 0; i < 3; i++) {
      const parameters = page.getByRole("button", { name: "View parameters", exact: true });
      await parameters.click(); await expect(page.getByRole("dialog", { name: "Tool parameters", exact: true })).toBeVisible();
      // Backend commits must remove a currently open host overlay with its owner.
      await h.manage("disable");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(page.locator('iframe[title^="Excalidraw "]')).toHaveCount(0);
      expect(await listeners()).toEqual(before);
      await expect(page.locator(".excalidraw-tooltip, .Modal")).toHaveCount(0);
      await h.manage("enable");
      await expect(page.locator("[data-hosted-tool-card]")).toHaveCount(1);
      await expect(page.frameLocator('iframe[title="Excalidraw tool"]').getByRole("img")).toBeVisible();
      expect((await h.action("get", { id: created.id })).scene.elements.some((e: any) => e.text === "中文输入回归")).toBe(true);
    }
    expect(h.errors).toEqual([]); expect(h.external).toEqual([]); expect(consoleErrors).toEqual([]);
  } finally { await h.close(); }
});

test("independent cards/editors retain dirty views when close, uninstall and update cannot save", async ({ page }, info) => {
  test.skip(!process.env.HOSTED_EXCALIDRAW_TGZ, "Explicit independently built archive required");
  test.setTimeout(110_000);
  const h = await hostedParity(page);
  let failSync = false;
  try {
    const first = await h.tool("excalidraw_create_view", { ...boxes(), title: "First drawing" });
    const second = await h.tool("excalidraw_create_view", { ...boxes(), title: "Second drawing" });
    await page.goto(h.bridge.url);
    const cards = page.locator("[data-hosted-tool-card]"); await expect(cards).toHaveCount(2);
    for (let i = 0; i < 2; i++) await expect(page.frameLocator('iframe[title="Excalidraw tool"]').nth(i).getByRole("img")).toBeVisible();
    const firstToggle = cards.nth(0).getByRole("button", { name: "Toggle preview", exact: true });
    const secondToggle = cards.nth(1).getByRole("button", { name: "Toggle preview", exact: true });
    await firstToggle.click(); await expect(secondToggle).toHaveAttribute("aria-expanded", "true");
    await firstToggle.click(); await expect(firstToggle).toHaveAttribute("aria-expanded", "true");
    const editors = page.locator('iframe[title="Excalidraw editor"]');
    for (let i = 0; i < 2; i++) {
      const parameters = cards.nth(i).getByRole("button", { name: "View parameters", exact: true });
      await parameters.click();
      await expect(page.getByRole("dialog").locator("pre").first()).toContainText(i === 0 ? "First drawing" : "Second drawing");
      await page.keyboard.press("Escape"); await expect(parameters).toBeFocused();
      const preview = page.frameLocator('iframe[title="Excalidraw tool"]').nth(i);
      await preview.getByRole("button", { name: "Edit Excalidraw", exact: true }).click();
      await expect(editors).toHaveCount(i + 1);
    }
    const editor = page.frameLocator('iframe[title="Excalidraw editor"]').nth(1), canvas = editor.locator("canvas.interactive");
    await expect(canvas).toBeVisible();
    await expect.poll(async () => (await h.action("get", { id: second.id })).scene.appState.zoom?.value).toBe(1);
    const beforeFirst = await h.action("get", { id: first.id }), beforeSecond = await h.action("get", { id: second.id });
    const secondSource = await editors.nth(1).getAttribute("src");
    await page.route("**/api/hosted-plugins/action", route => failSync && route.request().postDataJSON()?.action === "sync"
      ? route.fulfill({ status: 503, json: { error: { code: "test_save_failed", message: "Injected checkpoint failure" } } }) : route.continue());
    failSync = true;
    await canvas.click(); await page.keyboard.press("ControlOrMeta+a"); await page.keyboard.press("ArrowRight"); await page.keyboard.press("Escape");
    await expect(editor.getByRole("alert")).toContainText("Injected checkpoint failure");
    const tab = await editors.nth(1).locator("xpath=ancestor::*[@data-dockkit-content]").getAttribute("data-dockkit-content");
    await page.locator(`[data-dockkit-tab="${tab}"]`).hover();
    await page.locator(`[data-dockkit-tab-close="${tab}"]`).click();
    await expect(page.locator('[data-sidebar-right-panel]').getByRole("alert")).toContainText("Injected checkpoint failure");
    await expect(editors).toHaveCount(2); expect(await editors.nth(1).getAttribute("src")).toBe(secondSource);

    const collapse = page.getByRole("button", { name: "Collapse right sidebar", exact: true });
    if (await collapse.isVisible()) await collapse.click();
    await page.getByRole("button", { name: "Plugins", exact: true }).click();
    const manager = page.locator("[data-hosted-management]");
    await manager.getByRole("button", { name: "Excalidraw (Official)", exact: true }).click();
    await manager.getByRole("button", { name: "Uninstall", exact: true }).click();
    const uninstall = page.getByRole("dialog", { name: "Uninstall Excalidraw?", exact: true });
    await expect(uninstall).toContainText("failed save stops uninstallation");
    await uninstall.getByRole("button", { name: "Uninstall", exact: true }).click();
    await expect(manager.getByRole("alert")).toBeVisible();
    expect((await h.card()).enabled).toBe(true); expect((await h.card()).installed).toBe(true);
    await expect(editors).toHaveCount(2);
    const generation = (await h.card()).generation!;
    h.upgrade(); await h.manage("update");
    await page.getByRole("button", { name: "Refresh plugins", exact: true }).click();
    await manager.getByRole("button", { name: "Update and reopen now", exact: true }).click();
    const update = page.getByRole("dialog", { name: "Update Excalidraw and reopen now?", exact: true });
    await expect(update).toContainText("Undo/redo history will be cleared");
    await update.getByRole("button", { name: "Update and reopen", exact: true }).click();
    await expect(manager.getByRole("alert")).toBeVisible();
    expect((await h.card()).generation).toBe(generation); expect(await editors.nth(1).getAttribute("src")).toBe(secondSource);

    failSync = false;
    await page.getByRole("button", { name: "Hosted test", exact: true }).click();
    // Reveal the exact retained tab through the public preview action.
    await page.frameLocator('iframe[title="Excalidraw tool"]').nth(1).getByRole("button", { name: "Edit Excalidraw", exact: true }).click();
    await expect(editors).toHaveCount(2);
    await canvas.click(); await page.keyboard.press("ControlOrMeta+s");
    const save = editor.getByRole("dialog", { name: "Save diagram", exact: true });
    await save.getByRole("textbox", { name: "Workspace path", exact: true }).fill("diagrams/second.excalidraw");
    await save.getByRole("button", { name: "Save", exact: true }).click(); await expect(save).toHaveCount(0);
    const saved = JSON.parse(await readFile(join(h.root, "diagrams/second.excalidraw"), "utf8"));
    expect(saved.elements[0].x).not.toBe(beforeSecond.scene.elements[0].x);
    expect((await h.action("get", { id: first.id })).scene.elements).toEqual(beforeFirst.scene.elements);
    await info.attach("retained-dirty-scene", { body: JSON.stringify(saved), contentType: "application/json" });
    await h.manage("update", { reopenEditors: true });
    await expect.poll(async () => (await h.card()).generation).toBe(generation + 1);
    await expect(editors).toHaveCount(2);
    expect((await h.action("get", { id: second.id })).scene.elements).toEqual(saved.elements);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(h.errors).toEqual([]); expect(h.external).toEqual([]);
  } finally { failSync = false; await h.close(); }
});
