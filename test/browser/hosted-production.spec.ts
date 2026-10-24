import { test, expect } from "@playwright/test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { HostedPluginIntegration } from "../../src/host/server/plugins/hosted/integration.ts";
import { WorkspaceSessions } from "../../src/host/server/sessions/workspace-sessions.ts";
import { startBridge, type Bridge } from "../../src/host/server/transport/bridge.ts";
import { NodeTelemetry } from "../../src/platform/telemetry/telemetry.ts";
import { terminalHost } from "../helpers/terminal-host.ts";
import { integrationFixture } from "../helpers/hosted-integration-fixture.ts";

const id = "@chengzhiyi/pi-excalidraw";
/** A second local test release of identical payload, NOT a published upstream version. */
function localRelease(bytes: Buffer, version: string) {
  const archive = gunzipSync(bytes), parts: Buffer[] = [];
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = Buffer.from(archive.subarray(offset, offset + 512));
    if (header.every(byte => byte === 0)) break;
    const name = header.toString("utf8", 0, 100).replace(/\0.*$/, "");
    const size = parseInt(header.toString("ascii", 124, 136).replace(/\0.*$/, "").trim(), 8);
    let data = archive.subarray(offset + 512, offset + 512 + size);
    if (name === "package/package.json") data = Buffer.from(JSON.stringify({ ...JSON.parse(data.toString()), version }));
    header.fill(0, 124, 136); header.write(data.length.toString(8).padStart(11, "0") + "\0", 124);
    header.fill(32, 148, 156); header.write([...header].reduce((a, b) => a + b, 0).toString(8).padStart(6, "0") + "\0 ", 148);
    parts.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]));
}

for (const width of [1440, 390]) test(`real hosted archive + complete host UI + retained SDK hot lifecycle at ${width}px`, async ({ page }, info) => {
  test.skip(!process.env.HOSTED_EXCALIDRAW_TGZ, "Explicit cross-repo archive required");
  test.setTimeout(100_000); page.setDefaultTimeout(12_000);
  const root = await realpath(await mkdtemp(join(tmpdir(), "hosted-production-browser-")));
  const prior = process.env.PI_CODING_AGENT_DIR, roots = process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent"); process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS = "";
  const bytes = await readFile(process.env.HOSTED_EXCALIDRAW_TGZ!);
  let selected = bytes, version = "0.1.0", downloads = 0, bridge: Bridge | undefined, sessions!: WorkspaceSessions;
  const workerEntry = join(root, "worker.mjs");
  await build({ entryPoints: [new URL("../../src/host/server/plugins/hosted/worker-entry.ts", import.meta.url).pathname], outfile: workerEntry, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
  const scope = (cwd: string, sessionId: string) => ({ cwd, sessionId, workspaceId: "workspace" });
  const integration = new HostedPluginIntegration({ root: join(root, "hosted"), workerEntry, hostVersion: "0.1.29", ownerId: "local-test-principal",
    resolveSession: sessionId => { const retained = sessions?.hostedScope(sessionId); return retained ? scope(retained.cwd, sessionId) : null; },
    changed: () => bridge?.publish({ type: "hosted_plugins_changed" }),
    fetch: (async (url: string | URL | Request) => {
      if (String(url).endsWith(".tgz")) { downloads++; return new Response(selected); }
      return new Response(JSON.stringify({ versions: { [version]: { ...integrationFixture().release, version, dist: { tarball: `https://registry.npmjs.org/local-${version}.tgz`, integrity: "sha512-" + createHash("sha512").update(selected).digest("base64") } } } }));
    }) as typeof fetch,
  });
  sessions = new WorkspaceSessions(event => bridge?.publish(event), () => undefined, () => false, undefined, undefined, undefined, [], { adapter: integration.adapter, scope });
  await integration.start(); await sessions.open(root, "new");
  const retained = sessions.session!, sessionId = retained.sessionManager.getSessionId();
  const { host } = terminalHost(root); host.hosted = integration.handlers; host.snapshot = () => sessions.snapshot();
  host.workspaces = async () => ({ items: [{ id: "workspace", title: "Local workspace", path: root }], activeId: "workspace", sessions: [{ id: sessionId, workspaceId: "workspace", path: null, name: "Hosted test", modified: new Date().toISOString() }] });
  host.selectSession = async () => {};
  bridge = await startBridge(host, new URL("../../web/dist", import.meta.url).pathname, new NodeTelemetry({ env: { PI_WEB_SENTRY_ENABLED: "false" }, monitor: false }), { pluginSettingsFile: join(root, "plugins.json") });
  const address = new URL(bridge.url), headers = { Authorization: `Bearer ${address.hash.slice(1)}`, Origin: address.origin, "Content-Type": "application/json" };
  const card = () => integration.inventory().then(value => value.plugins[0]!);
  const action = async (action: string, input = {}) => {
    const response = await fetch(address.origin + "/api/hosted-plugins/action", { method: "POST", headers, body: JSON.stringify({ pluginId: id, generation: (await card()).generation, sessionId, action, input }) });
    expect(response.status).toBe(200); return response.json();
  };
  const errors: string[] = [], external: string[] = [], requests: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { requests.push(request.url()); if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== address.origin) external.push(request.url()); });
  await page.setViewportSize({ width, height: 1000 });
  await page.addInitScript(() => { localStorage.setItem("pi-web-locale", "en"); localStorage.setItem("pi-web-theme", "light"); Reflect.deleteProperty(window, "showSaveFilePicker"); });
  const manager = page.locator("[data-hosted-management]");
  const showManager = async () => {
    const collapse = page.getByRole("button", { name: "Collapse right sidebar", exact: true });
    if (width < 767 && await collapse.isVisible()) await collapse.click();
    await page.getByRole("button", { name: "Plugins", exact: true }).click();
    await expect(manager).toBeVisible();
  };
  try {
    await page.goto(bridge.url);
    const bootId = await page.evaluate(() => { const value = crypto.randomUUID(); (window as any).__hostedTestBoot = value; return value; });
    await showManager(); await expect(manager).toContainText("Not installed"); expect(downloads).toBe(0);
    expect(requests.filter(url => /\/hosted-plugins\/|Excalifont|Virgil|Xiaolai|mermaid/i.test(url))).toEqual([]);
    expect(retained.getAllTools().some(tool => /^(diagram_|excalidraw_)/.test(tool.name))).toBe(false);
    await manager.getByRole("button", { name: "Install", exact: true }).click();
    await expect(manager).toContainText("Installed · Disabled"); expect(downloads).toBe(1);
    await manager.getByRole("button", { name: "Enable", exact: true }).click();
    await expect(manager).toContainText("Installed · Enabled");
    // Real SDK tool invocation, deterministic provider transport only. No external model call.
    const model = retained.modelRuntime.getModels("openai")[0]!;
    await retained.modelRuntime.setRuntimeApiKey("openai", "fixture-no-network"); await retained.setModel(model);
    let stage = 0;
    const drawing = { title: "中文热插拔", elements: JSON.stringify([{ type: "rectangle", id: "box", x: 0, y: 0, width: 200, height: 100, label: { text: "中文热插拔" } }]) };
    retained.agent.streamFunction = async model => {
      const first = stage++ === 0;
      const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: first ? [{ type: "toolCall", id: "hosted-draw", name: "excalidraw_create_view", arguments: drawing }] : [{ type: "text", text: "Ready" }], stopReason: first ? "toolUse" : "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream(); stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: first ? "toolUse" : "stop", message }); stream.end(message); return stream;
    };
    await retained.prompt("Draw a local diagram");
    const expandSidebar = page.getByRole("button", { name: "Expand sidebar", exact: true });
    if (await expandSidebar.isVisible()) await expandSidebar.click();
    await page.getByRole("button", { name: "Hosted test", exact: true }).click();
    const tool = page.frameLocator('iframe[title="Excalidraw tool"]');
    await expect(tool.getByRole("img")).toBeVisible();
    const result = retained.messages.find(message => message.role === "toolResult" && message.toolCallId === "hosted-draw");
    expect(result?.role === "toolResult" && !result.isError).toBeTruthy();
    const draftId = (result as any).details.id;
    await tool.getByRole("button", { name: "Edit Excalidraw", exact: true }).click();
    const editor = page.frameLocator('iframe[title="Excalidraw editor"]');
    const canvas = editor.locator(".excalidraw canvas.interactive"); await expect(canvas).toBeVisible();
    await canvas.click(); await page.keyboard.press("ControlOrMeta+a"); await page.keyboard.press("ArrowRight"); await page.keyboard.press("Escape");
    await expect.poll(async () => (await action("get", { id: draftId })).scene.elements.find((element: any) => element.id === "box")?.x).not.toBe(0);
    const moved = (await action("get", { id: draftId })).scene.elements.find((element: any) => element.id === "box").x;
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(async () => (await action("get", { id: draftId })).scene.elements.find((element: any) => element.id === "box")?.x).toBe(0);
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect.poll(async () => (await action("get", { id: draftId })).scene.elements.find((element: any) => element.id === "box")?.x).toBe(moved);
    await editor.getByTestId("main-menu-trigger").click();
    await editor.getByText("Export image...", { exact: true }).click();
    const imageExport = editor.getByRole("dialog"); await expect(imageExport).toBeVisible();
    const [png] = await Promise.all([page.waitForEvent("download"), imageExport.getByRole("button", { name: "Export to PNG", exact: true }).click()]);
    await png.saveAs(info.outputPath(`hosted-${width}.png`));
    expect([...(await readFile((await png.path())!)).subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    await imageExport.getByRole("button", { name: "Close", exact: true }).click();
    await canvas.click(); await page.keyboard.press("ControlOrMeta+s");
    const save = editor.getByRole("dialog", { name: "Save diagram", exact: true });
    await save.getByRole("textbox", { name: "Workspace path", exact: true }).fill("diagrams/中文.excalidraw"); await save.getByRole("button", { name: "Save", exact: true }).click();
    await expect(save).toHaveCount(0); const saved = await readFile(join(root, "diagrams/中文.excalidraw"));
    const before = await action("get", { id: draftId }), generation = (await card()).generation!;
    version = "0.1.1"; selected = localRelease(bytes, version);
    await showManager(); await manager.getByRole("button", { name: "Update (wait for editors)", exact: true }).click();
    await expect(manager).toContainText("Pending version (close editors first): 0.1.1"); expect((await card()).generation).toBe(generation);
    page.once("dialog", dialog => dialog.accept());
    await manager.getByRole("button", { name: "Update and reopen now (clears undo history)", exact: true }).click();
    await expect.poll(async () => (await card()).generation, { timeout: 20_000 }).toBe(generation + 1);
    await expect(manager).not.toContainText("Pending version");
    const after = await action("get", { id: draftId }); expect(after.scene).toEqual(before.scene); expect(after.revision).toBe(before.revision);
    expect(sessions.session).toBe(retained); expect(await page.evaluate(() => (window as any).__hostedTestBoot)).toBe(bootId);
    // New realms initially register busy until their handshake/status acknowledgement completes.
    await expect(page.locator(`iframe[title^="Excalidraw "][src*="generation=${generation + 1}"]`)).toHaveCount(3);
    await expect.poll(() => [...(integration as any).views.values()].every((coordinator: any) => coordinator.views.size === 3 && [...coordinator.views.values()].every((view: any) => view.identity.generation === generation + 1 && !view.busy)), { timeout: 10_000 }).toBe(true);
    page.once("dialog", dialog => dialog.accept()); await manager.getByRole("button", { name: "Disable", exact: true }).click();
    await expect(manager).toContainText("Installed · Disabled");
    expect(retained.getAllTools().find(tool => tool.name === "diagram_read")!.exposure).toBe("hidden");
    await expect(page.locator('iframe[title^="Excalidraw "]')).toHaveCount(0);
    page.once("dialog", dialog => dialog.accept()); await manager.getByRole("button", { name: "Uninstall", exact: true }).click();
    await expect(manager).toContainText("Not installed"); expect(await readFile(join(root, "diagrams/中文.excalidraw"))).toEqual(saved);
    await manager.getByRole("button", { name: "Install", exact: true }).click(); await expect(manager).toContainText("Installed · Disabled");
    await manager.getByRole("button", { name: "Enable", exact: true }).click(); await expect(manager).toContainText("Installed · Enabled");
    expect((await action("get", { id: draftId })).scene).toEqual(before.scene);
    expect(await page.evaluate(() => (window as any).__hostedTestBoot)).toBe(bootId); expect(sessions.session).toBe(retained);
    await page.screenshot({ path: info.outputPath(`hosted-lifecycle-${width}.png`) });
    expect(errors).toEqual([]); expect(external).toEqual([]);
  } catch (error) {
    await page.screenshot({ path: info.outputPath("primary-failure.png") });
    throw error;
  } finally {
    // Keep MessagePorts and the page alive until registered views acknowledge shutdown.
    await integration.shutdown();
    await page.close();
    await bridge.close(); await sessions.dispose();
    if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior;
    if (roots === undefined) delete process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS; else process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS = roots;
    await rm(root, { recursive: true, force: true });
  }
});
