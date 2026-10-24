import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBridge } from "../../src/host/server/transport/bridge.ts";
import { terminalHost } from "../helpers/terminal-host.ts";
import { publishDrawing } from "../helpers/diagram-browser.ts";
import { DIAGRAM_PLUGIN, type DiagramDraft } from "../../src/plugins/builtin/diagrams/contract/diagrams.ts";
import { diagramReference } from "../../src/plugins/builtin/diagrams/contract/reference.ts";

for (const width of [1440, 390]) for (const saved of [false, true]) test(`same drawing survives bridge reconstruction without browser backups; saved=${saved}, ${width}px`, async ({ page }, info) => {
  test.setTimeout(60_000); page.setDefaultTimeout(12_000);
  const cwd = await mkdtemp(join(tmpdir(), "pi-diagram-durable-browser-")), { host } = terminalHost(cwd);
  const options = { pluginSettingsFile: join(cwd, "plugins.json") };
  let bridge = await startBridge(host, new URL("../../web/dist/", import.meta.url).pathname, undefined, options);
  const priorPort = process.env.PI_WEBAPP_RESTART_PORT, priorToken = process.env.PI_WEBAPP_RESTART_TOKEN;
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await page.setViewportSize({ width, height: 1000 });
  await page.addInitScript(() => { if (location.protocol === "http:") { localStorage.setItem("pi-web-locale", "en"); localStorage.setItem("pi-web-theme", "dark"); } });
  const action = async <T,>(name: string, input: object = {}): Promise<T> => {
    const url = new URL(bridge.url);
    const response = await fetch(url.origin + `/api/diagrams/${name}`, { method: "POST", headers: { Authorization: `Bearer ${url.hash.slice(1)}`, "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: "terminal-a", ...input }) });
    expect(response.status).toBe(200); return response.json();
  };
  try {
    const created = await bridge.runPluginTool(DIAGRAM_PLUGIN, cwd, "terminal-a", "view", diagramReference.elementsExample) as { id: string };
    publishDrawing(host, bridge, created, "Restart recovery");
    await page.goto(bridge.url);
    const artifact = page.getByRole("article", { name: "Diagram: Restart recovery", exact: true });
    await expect(artifact.getByRole("img")).toBeVisible();
    await artifact.getByRole("button", { name: "Edit Excalidraw", exact: true }).click();
    const panel = page.locator("[data-sidebar-right-session]"), canvas = panel.locator("canvas.interactive");
    await expect(canvas).toBeVisible();
    const before = await action<DiagramDraft>("get", { id: created.id });
    await canvas.click(); await page.keyboard.press("ControlOrMeta+a"); await page.keyboard.press("ArrowRight"); await page.keyboard.press("Escape");
    await expect.poll(async () => (await action<DiagramDraft>("get", { id: created.id })).revision).toBeGreaterThan(before.revision);
    const original = await action<DiagramDraft>("get", { id: created.id });
    if (saved) await action("save", { id: created.id, revision: original.revision, path: "diagrams/original.excalidraw" });
    await page.evaluate(() => { for (const key of Object.keys(localStorage)) if (key.startsWith("pi-diagram:")) localStorage.removeItem(key); });
    const oldUrl = new URL(bridge.url);
    await page.goto("about:blank"); await bridge.close();
    process.env.PI_WEBAPP_RESTART_PORT = oldUrl.port; process.env.PI_WEBAPP_RESTART_TOKEN = oldUrl.hash.slice(1);
    bridge = await startBridge(host, new URL("../../web/dist/", import.meta.url).pathname, undefined, options);
    expect(new URL(bridge.url).origin).toBe(oldUrl.origin);
    await page.goto(bridge.url);
    await expect(artifact.getByRole("img")).toBeVisible();
    await expect(artifact.getByText("Original unavailable", { exact: true })).toHaveCount(0);
    await artifact.getByRole("button", { name: "Edit Excalidraw", exact: true }).click();
    await expect(canvas).toBeVisible();
    // Native normalization is idempotent after the first edit; assert geometry/text and identity too.
    const geometry = (draft: DiagramDraft) => draft.scene.elements.map(({ id, type, x, y, width, height, text, groupIds }) => ({ id, type, x, y, width, height, text, groupIds }));
    const restored = await action<DiagramDraft>("get", { id: created.id });
    expect(geometry(restored)).toEqual(geometry(original));
    expect(restored.path).toBe(saved ? "diagrams/original.excalidraw" : null);
    expect((await action<DiagramDraft[]>("list")).length).toBe(1);
    expect((await bridge.runPluginTool(DIAGRAM_PLUGIN, cwd, "terminal-a", "read", {}) as { id: string }).id).toBe(created.id);
    await expect(panel.locator("[data-diagram-unavailable]")).toHaveCount(0);
    await expect(panel.getByRole("dialog")).toHaveCount(0); await expect(panel.getByRole("textbox")).toHaveCount(0);
    await panel.locator(".excalidraw").getByTestId("main-menu-trigger").click();
    await expect(panel.getByText("Open workspace diagram", { exact: true })).toHaveCount(0);
    await panel.locator(".excalidraw").getByTestId("main-menu-trigger").click();
    await page.screenshot({ path: info.outputPath(`durable-dark-${saved}-${width}.png`) });
    expect(errors).toEqual([]);
  } finally {
    if (priorPort === undefined) delete process.env.PI_WEBAPP_RESTART_PORT; else process.env.PI_WEBAPP_RESTART_PORT = priorPort;
    if (priorToken === undefined) delete process.env.PI_WEBAPP_RESTART_TOKEN; else process.env.PI_WEBAPP_RESTART_TOKEN = priorToken;
    await page.close(); await bridge.close(); await rm(cwd, { recursive: true, force: true });
  }
});

for (const width of [1440, 390]) test(`truly missing historical card has no edit entry, no automatic replacement, dark theme at ${width}px`, async ({ page }, info) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-diagram-missing-")), { host } = terminalHost(cwd);
  const bridge = await startBridge(host, new URL("../../web/dist/", import.meta.url).pathname);
  await page.setViewportSize({ width, height: 1000 });
  await page.addInitScript(() => { localStorage.setItem("pi-web-locale", "en"); localStorage.setItem("pi-web-theme", "dark"); });
  let reads = 0, creations = 0;
  page.on("request", r => { if (r.url().endsWith("/api/diagrams/get")) reads++; if (r.url().endsWith("/api/diagrams/new")) creations++; });
  try {
    publishDrawing(host, bridge, { id: "legacy-missing" }, "Missing drawing");
    await page.goto(bridge.url);
    const card = page.getByRole("article", { name: "Diagram: Missing drawing", exact: true });
    await expect(card.getByText("Original unavailable", { exact: true })).toBeVisible();
    await expect(card.getByRole("button", { name: "Edit Excalidraw", exact: true })).toHaveCount(0);
    await expect(card.getByRole("img")).toHaveCount(0);
    await expect(card).toContainText("No content is available");
    const color = await card.evaluate(el => getComputedStyle(el).backgroundColor); expect(color).not.toBe("rgb(255, 255, 255)");
    await page.waitForTimeout(1500); expect(reads).toBeLessThanOrEqual(2); expect(creations).toBe(0);
    await page.screenshot({ path: info.outputPath(`missing-dark-${width}.png`) });
  } finally { await page.close(); await bridge.close(); await rm(cwd, { recursive: true, force: true }); }
});

test("storage, network and permission failures do not masquerade as missing content", async ({ page }) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-diagram-storage-errors-")), { host } = terminalHost(cwd);
  const bridge = await startBridge(host, new URL("../../web/dist/", import.meta.url).pathname);
  await page.addInitScript(() => localStorage.setItem("pi-web-locale", "en"));
  let creations = 0, status = 500;
  page.on("request", r => { if (r.url().endsWith("/api/diagrams/new")) creations++; });
  await page.route("**/api/diagrams/get", r => r.fulfill({ status, contentType: "application/json", body: JSON.stringify({ error: "Storage or permission error", errorCode: "validation_error", reason: "diagram_storage_error" }) }));
  try {
    publishDrawing(host, bridge, { id: "test-error" }, "Storage failure");
    for (status of [403, 409, 500, 404]) {
      await page.goto(bridge.url);
      const card = page.getByRole("article", { name: "Diagram: Storage failure", exact: true });
      await expect(card.getByRole("alert")).toBeVisible();
      await expect(card.getByRole("button", { name: "Edit Excalidraw", exact: true })).toBeVisible();
      await expect(card.getByText("Original unavailable", { exact: true })).toHaveCount(0);
      expect(creations).toBe(0);
    }
  } finally { await page.close(); await bridge.close(); await rm(cwd, { recursive: true, force: true }); }
});
