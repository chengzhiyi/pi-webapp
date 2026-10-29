import { test, expect } from "@playwright/test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { HostedPluginIntegration } from "../../src/host/server/plugins/hosted/integration.ts";
import { WorkspaceSessions } from "../../src/host/server/sessions/workspace-sessions.ts";
import { startBridge, type Bridge } from "../../src/host/server/transport/bridge.ts";
import { NodeTelemetry } from "../../src/platform/telemetry/telemetry.ts";
import { terminalHost } from "../helpers/terminal-host.ts";
import { environmentFetch } from "../../bin/http-transport.mjs";

// Explicit online opt-in. No local archive, fake release/version, or registry response substitution.
const upgradeFrom = process.env.HOSTED_NPM_UPGRADE_FROM;
for (const width of [1440, 390]) test(`published npm ${upgradeFrom ? `upgrade from ${upgradeFrom}` : "install"} and retained-session drawing lifecycle at ${width}px`, async ({ page }, info) => {
  test.skip(process.env.HOSTED_NPM_VERIFY !== "1", "Explicit public npm verification required");
  test.setTimeout(180_000); page.setDefaultTimeout(15_000);
  const id = "@chengzhiyi/pi-excalidraw";
  let version = process.env.HOSTED_NPM_VERSION;
  const root = await realpath(await mkdtemp(join(tmpdir(), "hosted-npm-browser-")));
  const prior = process.env.PI_CODING_AGENT_DIR, roots = process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent"); process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS = "";
  const registry: { url: string; status: number; error?: string }[] = [];
  const nativeFetch = globalThis.fetch;
  const workerEntry = join(root, "worker.mjs");
  await build({ entryPoints: [new URL("../../src/host/server/plugins/hosted/worker-entry.ts", import.meta.url).pathname], outfile: workerEntry, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
  let bridge: Bridge | undefined, sessions!: WorkspaceSessions;
  const scope = (cwd: string, sessionId: string) => ({ cwd, sessionId, workspaceId: "workspace" });
  const integration = new HostedPluginIntegration({ root: join(root, "hosted"), workerEntry, hostVersion: "0.1.29", ownerId: "npm-verification-principal",
    resolveSession: sessionId => { const retained = sessions?.hostedScope(sessionId); return retained ? scope(retained.cwd, sessionId) : null; },
    changed: () => bridge?.publish({ type: "hosted_plugins_changed" }),
    fetch: (async (...args: Parameters<typeof fetch>) => {
      try {
        // Observe the production transport, including the user's environment
        // proxy. Do not rewrite metadata, archives, response bytes or integrity.
        const response = await environmentFetch(...args);
        registry.push({ url: String(args[0]), status: response.status }); return response;
      } catch (error) {
        registry.push({ url: String(args[0]), status: 0, error: `${String(error)}; cause=${String((error as Error).cause)}` });
        throw error; // Keep failures visible; never substitute an archive or silently retry.
      }
    }) as typeof fetch,
  });
  sessions = new WorkspaceSessions(event => bridge?.publish(event), () => undefined, () => false, undefined, undefined, undefined, [], { adapter: integration.adapter, scope });
  const errors: string[] = [], external: string[] = [];
  let primaryError: unknown;
  try {
    await integration.start();
    version ??= (await integration.manager.installer.check(id)).version;
    await sessions.open(root, "new");
    const retained = sessions.session!, sessionId = retained.sessionManager.getSessionId();
    const { host } = terminalHost(root); host.hosted = integration.handlers; host.snapshot = () => sessions.snapshot();
    host.workspaces = async () => ({ items: [{ id: "workspace", title: "Online verification", path: root }], activeId: "workspace", sessions: [{ id: sessionId, workspaceId: "workspace", path: null, name: "Published npm test", modified: new Date().toISOString() }] });
    host.selectSession = async () => {};
    bridge = await startBridge(host, new URL("../../web/dist", import.meta.url).pathname, new NodeTelemetry({ env: { PI_WEB_SENTRY_ENABLED: "false" }, monitor: false }), { pluginSettingsFile: join(root, "plugins.json") });
    const address = new URL(bridge.url), headers = { Authorization: `Bearer ${address.hash.slice(1)}`, Origin: address.origin, "Content-Type": "application/json" };
    const card = () => integration.inventory().then(value => value.plugins[0]!);
    const action = async (action: string, input = {}) => {
      const response = await nativeFetch(address.origin + "/api/hosted-plugins/action", { method: "POST", headers, body: JSON.stringify({ pluginId: id, generation: (await card()).generation, sessionId, action, input }) });
      expect(response.status).toBe(200); return response.json();
    };
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== address.origin) external.push(request.url()); });
    await page.setViewportSize({ width, height: 1000 });
    await page.addInitScript(() => { localStorage.setItem("pi-web-locale", "en"); localStorage.setItem("pi-web-theme", "light"); Reflect.deleteProperty(window, "showSaveFilePicker"); });
    const manager = page.locator("[data-hosted-management]");
    const showManager = async () => {
      const collapse = page.getByRole("button", { name: "Collapse right sidebar", exact: true });
      if (width < 767 && await collapse.isVisible()) await collapse.click();
      await page.getByRole("button", { name: "Plugins", exact: true }).click(); await expect(manager).toBeVisible();
      const open = manager.getByRole("button", { name: "Excalidraw (Official)", exact: true });
      if (await open.isVisible()) await open.click();
    };
    await page.goto(bridge.url);
    const bootId = await page.evaluate(() => { const value = crypto.randomUUID(); (window as any).__npmTestBoot = value; return value; });
    await showManager(); await expect(manager).toContainText("Not installed");
    expect(registry.filter(item => item.url.endsWith(".tgz"))).toHaveLength(0);
    expect(retained.getAllTools().some(tool => /^(diagram_|excalidraw_)/.test(tool.name))).toBe(false);
    if (upgradeFrom) {
      expect(upgradeFrom).not.toBe(version);
      // Install a real prior public version through the authenticated production route.
      // No registry metadata rewriting to make an old version appear latest.
      const response = await nativeFetch(address.origin + "/api/hosted-plugins/manage", { method: "POST", headers, body: JSON.stringify({ pluginId: id, operation: "install", version: upgradeFrom }) });
      expect(response.status, await response.text()).toBe(200);
    } else await manager.getByRole("button", { name: "Download", exact: true }).click();
    await expect(manager).toContainText("Installed · Disabled", { timeout: 60_000 });
    expect((await card()).version).toBe(upgradeFrom ?? version);
    expect(registry.some(item => item.url.includes("registry.npmjs.org/") && !item.url.endsWith(".tgz") && item.status === 200)).toBe(true);
    expect(registry.filter(item => item.url.endsWith(".tgz"))).toEqual([{ url: `https://registry.npmjs.org/@chengzhiyi/pi-excalidraw/-/pi-excalidraw-${upgradeFrom ?? version}.tgz`, status: 200 }]);
    await manager.getByRole("switch", { name: "Enable Excalidraw", exact: true }).click(); await expect(manager).toContainText("Installed · Enabled");
    const model = retained.modelRuntime.getModels("openai")[0]!;
    await retained.modelRuntime.setRuntimeApiKey("openai", "fixture-no-network"); await retained.setModel(model);
    let stage = 0;
    retained.agent.streamFunction = async model => {
      const first = stage++ === 0;
      const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: first ? [{ type: "toolCall", id: "npm-draw", name: "excalidraw_create_view", arguments: { title: "npm 中文绘图", elements: JSON.stringify([{ type: "rectangle", id: "npm-box", x: 0, y: 0, width: 200, height: 100, label: { text: "npm 中文绘图" } }]) } }] : [{ type: "text", text: "Ready" }], stopReason: first ? "toolUse" : "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream(); stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: first ? "toolUse" : "stop", message }); stream.end(message); return stream;
    };
    await retained.prompt("Draw with the published plugin");
    const expand = page.getByRole("button", { name: "Expand sidebar", exact: true }); if (await expand.isVisible()) await expand.click();
    await page.getByRole("button", { name: "Published npm test", exact: true }).click();
    const tool = page.frameLocator('iframe[title="Excalidraw tool"]'); await expect(tool.getByRole("img")).toBeVisible();
    const result = retained.messages.find(message => message.role === "toolResult" && message.toolCallId === "npm-draw");
    expect(result?.role === "toolResult" && !result.isError).toBeTruthy(); const draftId = (result as any).details.id;
    await tool.getByRole("button", { name: "Edit Excalidraw", exact: true }).click();
    const editor = page.frameLocator('iframe[title="Excalidraw editor"]'); const canvas = editor.locator(".excalidraw canvas.interactive"); await expect(canvas).toBeVisible();
    await canvas.click(); await page.keyboard.press("ControlOrMeta+a"); await page.keyboard.press("ArrowRight"); await page.keyboard.press("Escape");
    await expect.poll(async () => (await action("get", { id: draftId })).scene.elements.find((element: any) => element.id === "npm-box")?.x).not.toBe(0);
    const moved = (await action("get", { id: draftId })).scene.elements.find((element: any) => element.id === "npm-box").x;
    await page.keyboard.press("ControlOrMeta+z"); await expect.poll(async () => (await action("get", { id: draftId })).scene.elements.find((element: any) => element.id === "npm-box")?.x).toBe(0);
    await page.keyboard.press("ControlOrMeta+Shift+z"); await expect.poll(async () => (await action("get", { id: draftId })).scene.elements.find((element: any) => element.id === "npm-box")?.x).toBe(moved);
    await editor.getByTestId("main-menu-trigger").click(); await editor.getByText("Export image...", { exact: true }).click();
    const imageExport = editor.getByRole("dialog"); const [png] = await Promise.all([page.waitForEvent("download"), imageExport.getByRole("button", { name: "Export to PNG", exact: true }).click()]);
    await png.saveAs(info.outputPath(`npm-${width}.png`)); expect([...(await readFile((await png.path())!)).subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    await imageExport.getByRole("button", { name: "Close", exact: true }).click();
    await canvas.click(); await page.keyboard.press("ControlOrMeta+s"); const save = editor.getByRole("dialog", { name: "Save diagram", exact: true });
    await save.getByRole("textbox", { name: "Workspace path", exact: true }).fill("diagrams/npm中文.excalidraw"); await save.getByRole("button", { name: "Save", exact: true }).click(); await expect(save).toHaveCount(0);
    const saved = await readFile(join(root, "diagrams/npm中文.excalidraw")), before = await action("get", { id: draftId });
    await showManager();
    if (upgradeFrom) {
      const generation = (await card()).generation!;
      await manager.getByRole("button", { name: "Update", exact: true }).click();
      // The public 15 MB archive downloads before a pending switch exists. Use the
      // same bounded network allowance as installation, not the 5s local-fixture default.
      await expect(manager).toContainText(`Close editors to update to: ${version}`, { timeout: 60_000 });
      expect((await card()).generation).toBe(generation);
      expect((await card()).version).toBe(upgradeFrom);
      expect(registry.some(item => item.url.endsWith(`pi-excalidraw-${version}.tgz`) && item.status === 200)).toBe(true);
      if (width === 1440) {
        const editorTab = page.locator("[data-dockkit-content]").filter({ has: page.locator('iframe[title="Excalidraw editor"]') });
        const tabId = await editorTab.getAttribute("data-dockkit-content");
        await page.getByRole("button", { name: "Published npm test", exact: true }).click();
        const expandRight = page.getByRole("button", { name: "Expand right sidebar", exact: true });
        if (await expandRight.isVisible()) await expandRight.click();
        await page.locator(`[data-dockkit-tab="${tabId}"]`).hover();
        await page.locator(`[data-dockkit-tab-close="${tabId}"]`).click();
        await expect(page.locator('iframe[title="Excalidraw editor"]')).toHaveCount(0);
        await showManager();
        await manager.getByRole("button", { name: "Apply pending update", exact: true }).click();
      } else {
        await manager.getByRole("button", { name: "Update and reopen now", exact: true }).click();
        await expect(page.getByRole("dialog")).toContainText("Undo/redo history will be cleared");
        await page.getByRole("dialog").getByRole("button", { name: "Update and reopen", exact: true }).click();
      }
      await expect.poll(async () => (await card()).generation, { timeout: 20_000 }).toBe(generation + 1);
      await expect(manager).toContainText(`Installed · Enabled ${version}`);
      const updated = await action("get", { id: draftId });
      expect(updated.scene).toEqual(before.scene); expect(updated.revision).toBe(before.revision);
      expect(await readFile(join(root, "diagrams/npm中文.excalidraw"))).toEqual(saved);
      expect(sessions.session).toBe(retained);
      expect(await page.evaluate(() => (window as any).__npmTestBoot)).toBe(bootId);
      expect(retained.getAllTools().find(tool => tool.name === "diagram_read")!.exposure).not.toBe("hidden");
      await page.screenshot({ path: info.outputPath(`npm-upgrade-${width}.png`) });
    }
    await manager.getByRole("switch", { name: "Enable Excalidraw", exact: true }).click(); await page.getByRole("dialog").getByRole("button", { name: "Disable", exact: true }).click(); await expect(manager).toContainText("Installed · Disabled");
    expect(retained.getAllTools().find(tool => tool.name === "diagram_read")!.exposure).toBe("hidden"); await expect(page.locator('iframe[title^="Excalidraw "]')).toHaveCount(0);
    await manager.getByRole("button", { name: "Uninstall", exact: true }).click(); await page.getByRole("dialog").getByRole("button", { name: "Uninstall", exact: true }).click(); await expect(manager).toContainText("Not installed");
    expect(await readFile(join(root, "diagrams/npm中文.excalidraw"))).toEqual(saved);
    await manager.getByRole("button", { name: "Reinstall", exact: true }).click(); await expect(manager).toContainText("Installed · Disabled", { timeout: 60_000 });
    await manager.getByRole("switch", { name: "Enable Excalidraw", exact: true }).click(); await expect(manager).toContainText("Installed · Enabled");
    expect((await action("get", { id: draftId })).scene).toEqual(before.scene); expect(sessions.session).toBe(retained);
    expect(await page.evaluate(() => (window as any).__npmTestBoot)).toBe(bootId); expect(errors).toEqual([]); expect(external).toEqual([]);
    await page.screenshot({ path: info.outputPath(`npm-lifecycle-${width}.png`) });
    await writeFile(info.outputPath("npm-receipt.json"), JSON.stringify({ version, width, registry, retainedSession: true, retainedParentPage: true, errors, external, upgrades: upgradeFrom ? { from: upgradeFrom, to: version, editorOpenStaged: true, switch: width === 1440 ? "close-editor then apply" : "explicit undo-reset consent then reopen", sceneAndFileRetained: true } : "not tested in this installation-only run" }, null, 2));
  } catch (error) {
    primaryError = error;
    const diagnostics = await integration.inventory().then(value => value.plugins.map(card => ({ pluginId: card.pluginId, error: card.error, updateDiagnostic: card.updateDiagnostic }))).catch(cause => ({ inventoryFailure: String(cause) }));
    await writeFile(info.outputPath("npm-failure.json"), JSON.stringify({ error: String(error), registry, errors, external, diagnostics }, null, 2));
    await page.screenshot({ path: info.outputPath("npm-failure.png") }).catch(() => {}); throw error;
  } finally {
    let shutdownError: unknown;
    try { await integration.shutdown(); } catch (error) { shutdownError = error; }
    await page.close(); await bridge?.close(); await sessions.dispose();
    if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior;
    if (roots === undefined) delete process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS; else process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS = roots;
    await rm(root, { recursive: true, force: true });
    if (shutdownError) throw new AggregateError([...(primaryError ? [primaryError] : []), shutdownError], "Real npm verification shutdown failed");
  }
});
