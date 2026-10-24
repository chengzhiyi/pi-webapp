import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { boxes, hostedParity } from "../helpers/hosted-parity.ts";

test.beforeEach(() => { test.skip(!process.env.HOSTED_EXCALIDRAW_TGZ, "Explicit archive required"); test.setTimeout(100_000); });

test("A06: 100 grouped elements and native viewport survive generation switch without parent/session recreation", async ({ page }, info) => {
  const h = await hostedParity(page);
  try {
    const created = await h.tool("excalidraw_create_view", boxes(100));
    await page.goto(h.bridge.url); const editor = await h.open();
    const canvas = editor.locator("canvas.interactive");
    await canvas.click(); await page.keyboard.press("ControlOrMeta+a"); await page.keyboard.press("ArrowRight"); await page.keyboard.press("Escape");
    await expect.poll(async () => (await h.action("get", { id: created.id })).scene.elements[0].x).not.toBe(0);
    await page.keyboard.press("ControlOrMeta+-");
    // Native panning, not an injected scene or a fabricated flush acknowledgement.
    const bounds = (await canvas.boundingBox())!;
    await page.keyboard.down("Space"); await page.mouse.move(bounds.x + 200, bounds.y + 400); await page.mouse.down(); await page.mouse.move(bounds.x + 240, bounds.y + 440, { steps: 5 }); await page.mouse.up(); await page.keyboard.up("Space");
    const before = await h.action("get", { id: created.id });
    expect(before.scene.elements).toHaveLength(100); expect(before.scene.elements.every((e: any) => e.groupIds.length === 1)).toBe(true);
    const boot = await page.evaluate(() => ((window as any).__parityBoot = crypto.randomUUID()));
    const generation = (await h.card()).generation!;
    h.upgrade(); await h.manage("update", { reopenEditors: true });
    await expect.poll(async () => (await h.card()).generation).toBe(generation + 1);
    await expect(canvas).toBeVisible();
    await expect.poll(async () => (await h.action("get", { id: created.id })).scene).toEqual(before.scene);
    expect((await h.action("get", { id: created.id })).revision).toBe(before.revision);
    expect(h.sessions.session).toBe(h.retained); expect(await page.evaluate(() => (window as any).__parityBoot)).toBe(boot);
    const stale = await h.rawAction("sync", { id: created.id, revision: before.revision, scene: before.scene }, generation); expect(stale.status).toBe(409);
    await info.attach("normalized-scene", { body: JSON.stringify(before.scene), contentType: "application/json" });
    expect(before.scene.appState, "Native zoom/pan must be checkpointed before generation teardown").toHaveProperty("zoom");
    expect(h.errors).toEqual([]); expect(h.external).toEqual([]);
  } finally { await h.close(); }
});

test("A07: composition and held native drag reject send, preserve composer and then reach a real safe point", async ({ page }, info) => {
  const h = await hostedParity(page);
  try {
    const created = await h.tool("excalidraw_create_view", boxes()); await page.goto(h.bridge.url); const editor = await h.open();
    const composer = page.getByRole("textbox", { name: "Send a message to the current Pi session", exact: true });
    await composer.fill("保留输入，等中文组合和拖动结束");
    // Synthetic browser composition lifecycle, not a claim of OS IME candidate-window coverage.
    await editor.locator("canvas.interactive").evaluate(e => e.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "中文" })));
    await composer.press("Enter");
    await expect(page.locator(".pi-error")).toContainText("composing or dragging"); await expect(composer).toHaveText("保留输入，等中文组合和拖动结束"); expect(h.sends()).toBe(0);
    await editor.locator("canvas.interactive").evaluate(e => e.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "中文" })));
    const before = await h.action("get", { id: created.id });
    const canvas = editor.locator("canvas.interactive"), bounds = (await canvas.boundingBox())!;
    await editor.getByRole("radio", { name: "Rectangle", exact: true }).locator("..").click();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 400); await page.mouse.down(); await page.mouse.move(bounds.x + bounds.width / 2 + 80, bounds.y + 470, { steps: 5 });
    // Programmatic host click preserves the actual pointer-down in the iframe.
    await page.getByRole("button", { name: "Send message", exact: true }).evaluate((button: HTMLButtonElement) => button.click());
    await expect(composer).toHaveText("保留输入，等中文组合和拖动结束"); expect(h.sends()).toBe(0);
    await page.mouse.up(); await page.keyboard.press("Escape");
    await expect.poll(async () => (await h.action("get", { id: created.id })).revision).toBeGreaterThan(before.revision);
    await composer.press("Enter"); await expect.poll(h.sends).toBe(1);
    await info.attach("safe-point", { body: JSON.stringify(await h.action("get", { id: created.id })), contentType: "application/json" });
    expect(h.errors).toEqual([]);
  } finally { await h.close(); }
});

test("A09: candidate reject/apply and stale hand-edit protection through actual tool and review frames", async ({ page }) => {
  const h = await hostedParity(page);
  try {
    const drawing = boxes(); drawing.elements = JSON.stringify(JSON.parse(drawing.elements).map((e: any) => ({ ...e, label: { text: "保留标签" } })));
    const created = await h.tool("excalidraw_create_view", drawing); await page.goto(h.bridge.url); let editor = await h.open();
    const get = () => h.action("get", { id: created.id });
    // Trusted tool invocation reaches the actual supervisor/worker. Reuse the original
    // chat card for review; repeated SDK result frames have a separate contention test.
    const propose = async (x: number) => {
      const draft = await get();
      await h.integration.manager.invoke("@chengzhiyi/pi-excalidraw", (await h.card()).generation!, { requestId: crypto.randomUUID(), kind: "tool", action: "patch", input: { id: created.id, baseRevision: draft.revision, patch: { updateElements: [{ id: "box-0", x }] } }, scope: { cwd: h.root, sessionId: h.sessionId, workspaceId: "workspace" } });
      const current = await get();
      await expect(review.getByRole("img")).toHaveAttribute("data-scene-revision", `${current.revision}:${current.candidate.id}`);
    };
    const review = page.frameLocator('iframe[title="Excalidraw tool"]').last();
    await propose(222); await expect(review.getByRole("button", { name: "Keep original", exact: true })).toBeVisible();
    await review.getByRole("button", { name: "Keep original", exact: true }).click(); await expect.poll(async () => (await get()).candidate).toBe(null); expect((await get()).scene.elements[0].x).not.toBe(222);
    await propose(333); await review.getByRole("button", { name: "Apply edits", exact: true }).click(); await expect.poll(async () => (await get()).scene.elements[0].x).toBe(333);
    // Wait for this clean editor realm to observe the accepted revision before editing.
    // A backend poll alone does not prove a sibling canvas has adopted it.
    const acceptedRevision = (await get()).revision;
    const editorMount = new URL((await page.locator('iframe[title="Excalidraw editor"]').getAttribute("src"))!, h.bridge.url).searchParams.get("mountId");
    await page.waitForResponse(async response => response.url().endsWith("/api/hosted-plugins/action") && response.request().postDataJSON()?.action === "get" && response.request().postDataJSON()?.mountId === editorMount && (await response.json()).revision === acceptedRevision);
    await editor.locator("canvas.interactive").evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await propose(999); const candidate = (await get()).candidate;
    editor = page.frameLocator('iframe[title="Excalidraw editor"]'); await editor.locator("canvas.interactive").click(); await page.keyboard.press("ControlOrMeta+a"); await page.keyboard.press("ArrowRight"); await page.keyboard.press("Escape");
    await expect.poll(async () => (await get()).scene.elements[0].x).not.toBe(333);
    await expect(review.getByRole("button", { name: "Apply edits", exact: true })).toBeDisabled();
    const draft = await get(); const response = await h.rawAction("accept", { id: created.id, revision: draft.revision, candidateId: candidate.id, scene: candidate.scene }); expect(response.status).toBe(409);
    expect((await get()).scene.elements[0].x).toBe(draft.scene.elements[0].x); expect((await get()).scene.elements[0].x).not.toBe(999);
    expect(h.errors).toEqual([]); expect(h.external).toEqual([]);
  } finally { await h.close(); }
});

test("A09: patching an unlabeled native shape must render a review rather than crash materialization", async ({ page }) => {
  const h = await hostedParity(page);
  try {
    const created = await h.tool("excalidraw_create_view", boxes()); await page.goto(h.bridge.url); await h.open();
    const draft = await h.action("get", { id: created.id });
    await h.tool("diagram_patch", { id: created.id, baseRevision: draft.revision, patch: { updateElements: [{ id: "box-0", x: 222 }] } });
    const review = page.frameLocator('iframe[title="Excalidraw tool"]').last();
    await expect(review.getByRole("button", { name: "Apply edits", exact: true })).toBeVisible();
    await expect(review.getByRole("img")).toBeVisible();
    await expect(review.getByRole("alert")).toHaveCount(0);
  } finally { await h.close(); }
});

test("A09: actual hosted tool frame paints progressive arguments before any final result", async ({ page }, info) => {
  const h = await hostedParity(page);
  try {
    await page.goto(h.bridge.url);
    await expect(page.getByRole("textbox", { name: "Send a message to the current Pi session", exact: true })).toBeVisible();
    const drawing = boxes(2), elements = JSON.parse(drawing.elements), timestamp = new Date().toISOString();
    const stream = (elements: string) => ({ id: "streaming-provider", role: "assistant" as const, timestamp, blocks: [{ kind: "toolCall" as const, toolCallId: "parity-1", toolName: "excalidraw_create_view", text: JSON.stringify({ title: drawing.title, elements }) }] });
    // Deterministic provider event transport, same public bridge used by the real SDK.
    h.bridge.publish({ type: "snapshot", session: { ...h.sessions.snapshot(), idle: false, messages: [{ id: "stream-user", role: "user", timestamp, blocks: [{ kind: "text", text: "Draw progressively" }] }], streaming: stream("[" + JSON.stringify(elements[0]) + ",{") } });
    const frame = page.frameLocator('iframe[title="Excalidraw tool"]'), preview = frame.locator("[data-stream-preview]");
    await expect(preview).toBeVisible(); const first = await preview.getAttribute("src");
    const frameIdentity = await page.locator('iframe[title="Excalidraw tool"]').getAttribute("src");
    expect(await h.action("list")).toEqual([]);
    await expect(page.locator('iframe[title="Excalidraw editor"]')).toHaveCount(0);
    h.bridge.publish({ type: "stream", message: stream(drawing.elements) });
    await expect.poll(() => preview.getAttribute("src")).not.toBe(first);
    await page.screenshot({ path: info.outputPath("before-result.png") });
    // Atomic stream-to-history projection retains call identity even if provisional
    // parent message IDs change. Verify the realm itself, not merely its pixels.
    h.bridge.publish({ type: "snapshot", session: { ...h.sessions.snapshot(), idle: false, messages: [{ id: "committed-user", role: "user", timestamp, blocks: [{ kind: "text", text: "Draw progressively (committed)" }] }, { ...stream(drawing.elements), id: "committed-assistant" }], streaming: null } });
    await expect(page.getByText("Draw progressively (committed)", { exact: true })).toBeVisible();
    await expect(page.locator('[data-tool-view]')).toHaveCount(1);
    await expect.poll(() => page.locator('iframe[title="Excalidraw tool"]').getAttribute("src")).toBe(frameIdentity);
    const created = await h.tool("excalidraw_create_view", drawing);
    await expect(preview).toHaveCount(0); await expect(frame.getByRole("img")).toBeVisible();
    await expect.poll(async () => (await h.action("get", { id: created.id })).scene.elements.length).toBe(2);
    expect(h.errors).toEqual([]); expect(h.external).toEqual([]);
  } finally { await h.close(); }
});

test("A11: same-profile second window must remain responsive with existing editor long polls", async ({ page }) => {
  const h = await hostedParity(page);
  try {
    await h.tool("excalidraw_create_view", boxes()); await page.goto(h.bridge.url); await h.open();
    const second = await page.context().newPage(); second.setDefaultTimeout(12_000);
    await second.goto(h.bridge.url); await h.open(second);
  } finally { await h.close(); }
});

for (const width of [1440, 390]) test(`A10: native source/Open, SVG, transparent PNG, retained backup and themed menus at ${width}px`, async ({ page }, info) => {
  const h = await hostedParity(page, { width, locale: width === 390 ? "zh" : "en", theme: width === 390 ? "dark" : "light" });
  try {
    const created = await h.tool("excalidraw_create_view", boxes()); await page.goto(h.bridge.url); const editor = await h.open();
    if (width === 390) await expect(editor.locator(".excalidraw")).toHaveClass(/theme--dark/);
    else await expect(editor.locator(".excalidraw")).not.toHaveClass(/theme--dark/);
    const menu = () => editor.getByTestId("main-menu-trigger").click();
    await menu(); for (const id of ["load-button", "json-export-button", "image-export-button", "help-menu-item", "clear-canvas-button"]) await expect(editor.getByTestId(id)).toBeVisible();
    await page.screenshot({ path: info.outputPath(`native-menu-${width}.png`) });
    await editor.getByTestId("image-export-button").click(); const dialog = editor.getByRole("dialog");
    const background = dialog.locator('input[name="exportBackgroundSwitch"]');
    if (await background.isChecked()) await background.uncheck();
    for (const format of ["SVG", "PNG"]) {
      const button = dialog.getByRole("button", { name: width === 390 ? `导出为 ${format}` : `Export to ${format}`, exact: true });
      const [file] = await Promise.all([page.waitForEvent("download"), button.click()]); const bytes = await readFile((await file.path())!);
      await file.saveAs(info.outputPath(`native-${width}.${format.toLowerCase()}`));
      if (format === "SVG") expect(bytes.toString()).toContain("<svg");
      else {
        expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
        expect(await page.evaluate(async bytes => { const image = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: "image/png" })); const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height; const ctx = canvas.getContext("2d")!; ctx.drawImage(image, 0, 0); return ctx.getImageData(0, 0, 1, 1).data[3]; }, [...bytes])).toBe(0);
      }
    }
    await dialog.locator(".Dialog__close").click();
    await menu(); await editor.getByTestId("json-export-button").click();
    const [source] = await Promise.all([page.waitForEvent("download"), editor.getByRole("dialog").locator(".Card-button").click()]);
    const scene = JSON.parse(await readFile((await source.path())!, "utf8")); expect(scene.elements.some((e: any) => e.id === "box-0")).toBe(true);
    expect(scene.elements).toEqual((await h.action("get", { id: created.id })).scene.elements);
    const imported = { ...scene, elements: [{ ...scene.elements[0], id: "native-open", x: 72 }] };
    await menu(); await editor.getByTestId("load-button").click();
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), editor.getByRole("dialog").getByRole("button", { name: width === 390 ? "从文件加载" : "Load from file", exact: true }).click()]);
    await chooser.setFiles({ name: "中文.excalidraw", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(imported)) });
    await expect.poll(async () => (await h.action("get", { id: created.id })).scene.elements.some((e: any) => e.id === "native-open")).toBe(true);
    expect((await h.action("list")).length).toBe(1);
    const backup = await editor.locator("body").evaluate((_, key) => localStorage.getItem(key), `pi-diagram:${h.sessionId}:${created.id}`); expect(JSON.parse(backup!).elements[0].id).toBe("native-open");
    const beforeTheme = (await h.action("get", { id: created.id })).scene;
    await page.evaluate(theme => { localStorage.setItem("pi-web-theme", theme); window.dispatchEvent(new StorageEvent("storage", { key: "pi-web-theme", newValue: theme })); }, width === 390 ? "light" : "dark");
    if (width === 390) await expect(editor.locator(".excalidraw")).not.toHaveClass(/theme--dark/);
    else await expect(editor.locator(".excalidraw")).toHaveClass(/theme--dark/);
    expect((await h.action("get", { id: created.id })).scene).toEqual(beforeTheme);
    expect(h.errors).toEqual([]); expect(h.external).toEqual([]);
  } finally { await h.close(); }
});

test("A11: competing real windows fence stale CAS and preserve losing local geometry for explicit reconnect recovery", async ({ page }, info) => {
  const h = await hostedParity(page);
  let release: (() => void) | undefined;
  try {
    const created = await h.tool("excalidraw_create_view", boxes()); await page.goto(h.bridge.url); const first = await h.open();
    // Independent browser profiles avoid HTTP/1.1 connection-pool contention; same-profile
    // long-poll starvation is covered separately, not hidden by mocked successful polls.
    const secondContext = await page.context().browser()!.newContext({ viewport: { width: 1440, height: 1000 } });
    const secondPage = await secondContext.newPage();
    await secondPage.addInitScript(() => localStorage.setItem("pi-web-locale", "en"));
    await secondPage.goto(h.bridge.url); let second = await h.open(secondPage);
    let blocked = false; const gate = new Promise<void>(resolve => { release = resolve; });
    await secondPage.route("**/api/hosted-plugins/action", async route => { if (route.request().postDataJSON()?.action === "sync") { blocked = true; await gate; } await route.continue(); });
    const before = await h.action("get", { id: created.id });
    await second.locator("canvas.interactive").click(); await secondPage.keyboard.press("ControlOrMeta+a"); await secondPage.keyboard.press("ArrowLeft"); await secondPage.keyboard.press("Escape"); await expect.poll(() => blocked).toBe(true);
    await first.locator("canvas.interactive").click(); await page.keyboard.press("ControlOrMeta+a"); await page.keyboard.press("ArrowRight"); await page.keyboard.press("Escape");
    await expect.poll(async () => (await h.action("get", { id: created.id })).revision).toBeGreaterThan(before.revision);
    const winner = await h.action("get", { id: created.id }); release!();
    await expect(second.getByRole("alert")).toBeVisible();
    const backupKey = `pi-diagram:${h.sessionId}:${created.id}`;
    const losing = await second.locator("body").evaluate((_, key) => localStorage.getItem(key), backupKey);
    expect(JSON.parse(losing!).elements[0].x).not.toBe(winner.scene.elements[0].x);
    expect((await h.action("get", { id: created.id })).scene).toEqual(winner.scene);
    const [download] = await Promise.all([secondPage.waitForEvent("download"), second.getByRole("button", { name: "Download draft", exact: true }).click()]);
    const rescued = JSON.parse(await readFile((await download.path())!, "utf8")); expect(rescued.elements).toEqual(JSON.parse(losing!).elements);
    await download.saveAs(info.outputPath("losing-window.excalidraw"));
    secondPage.on("dialog", dialog => dialog.accept()); await secondPage.reload(); second = await h.open(secondPage);
    await expect(second.getByText("Unsaved local backup found", { exact: false })).toBeVisible();
    expect((await h.action("get", { id: created.id })).scene).toEqual(winner.scene);
    await second.getByRole("button", { name: "Restore", exact: true }).click();
    await expect.poll(async () => (await h.action("get", { id: created.id })).scene.elements[0].x).toBe(JSON.parse(losing!).elements[0].x);
    expect((await h.action("get", { id: created.id })).revision).toBeGreaterThan(winner.revision);
    expect(h.errors).toEqual([]); expect(h.external).toEqual([]);
  } finally { release?.(); await h.close(); }
});
