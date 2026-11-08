import { test, expect, type FrameLocator, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { createAssistantMessageEventStream, type AssistantMessage, type ToolCall } from "@earendil-works/pi-ai";
import { HostedPluginIntegration } from "../../src/host/server/plugins/hosted/integration.ts";
import { HostedDevSources } from "../../src/host/server/plugins/hosted/dev-plugins.ts";
import { OFFICIAL_PLUGINS } from "../../src/host/server/plugins/hosted/official-catalog.ts";
import { WorkspaceSessions } from "../../src/host/server/sessions/workspace-sessions.ts";
import { startBridge, type Bridge } from "../../src/host/server/transport/bridge.ts";
import { NodeTelemetry } from "../../src/platform/telemetry/telemetry.ts";
import { terminalHost } from "../helpers/terminal-host.ts";

// pi-pencil inside the REAL host client. The built App's HostedFrame drives FrameAdapter and
// HostedViewClient (register → MessagePort handshake on iframe load → initialize → long poll) for
// the controller, workspace and editor mounts the workbench creates. The plugin is a developer
// root wired exactly as pi-host wires `hosted-dev.json`, so a rebuild runs the serialized `update`
// switch: every authoring view must answer the server's freeze barrier, then remount on commit,
// or be restored when the switch is cancelled after the freeze. Nothing in the view protocol is
// mocked; only the model stream is scripted.
// Needs a built plugin: PI_PENCIL_ROOT=<pi-extensions>/packages/pencil (with dist/).
const ID = "@chengzhiyi/pi-pencil";
const source = process.env.PI_PENCIL_ROOT ?? new URL("../../../pi-extensions/packages/pencil", import.meta.url).pathname;
// Opt-in, like the real-model test: without a build these tests are not registered at all. CI's hosted
// gate counts a skipped test as a failure, and CI has no pi-extensions checkout.
const pencilTest = existsSync(join(source, "dist", "frame.html")) ? test : (() => {}) as unknown as typeof test;
const LOGIN = [
  { op: "create", ref: "$screen", parent: "$page", type: "FRAME", props: { name: "Login", width: 390, height: 844, fill: "#FFFFFF", layout: { mode: "VERTICAL", gap: 16, padding: { top: 64, right: 24, bottom: 24, left: 24 } } } },
  { op: "create", ref: "$title", parent: "$screen", type: "TEXT", props: { name: "Title", text: { content: "登录 / ログイン", font: { family: "Noto Sans SC", style: "Bold", size: 28 }, color: "#111827" } } },
  { op: "create", ref: "$button", parent: "$screen", type: "FRAME", props: { name: "Primary button", fill: "#4F46E5", radius: 12, sizingH: "FILL", layout: { mode: "HORIZONTAL", justify: "CENTER", align: "CENTER", padding: { top: 14, bottom: 14 } } } },
  { op: "create", ref: "$buttonText", parent: "$button", type: "TEXT", props: { text: { content: "登录", font: { style: "Medium", size: 16 }, color: "#FFFFFF" } } },
];

async function pencilHost(page: Page) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hosted-pencil-mount-")));
  const plugin = join(root, "pencil"), cwd = join(root, "workspace");
  await cp(join(source, "package.json"), join(plugin, "package.json"));
  await cp(join(source, "dist"), join(plugin, "dist"), { recursive: true });
  await mkdir(cwd, { recursive: true });
  const prior = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const workerEntry = join(root, "worker.mjs");
  await build({ entryPoints: [new URL("../../src/host/server/plugins/hosted/worker-entry.ts", import.meta.url).pathname], outfile: workerEntry, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
  const dev = new HostedDevSources({ env: { PI_WEBAPP_HOSTED_DEV_ROOTS: plugin }, configPath: join(root, "none.json") });
  const statusPath = join(root, "hosted-dev-status.json");
  let bridge: Bridge | undefined, sessions!: WorkspaceSessions;
  const scope = (cwd: string, sessionId: string) => ({ cwd, sessionId, workspaceId: "workspace" });
  const integration = new HostedPluginIntegration({ root: join(root, "hosted"), workerEntry, hostVersion: "0.1.52", ownerId: "local-test-principal",
    dev, devStatusPath: statusPath, devPollMs: 100, devArchives: dev.archives, devRoots: dev.roots, catalog: [...OFFICIAL_PLUGINS, ...dev.catalog],
    resolveSession: sessionId => { const retained = sessions?.hostedScope(sessionId); return retained ? scope(retained.cwd, sessionId) : null; },
    changed: () => bridge?.publish({ type: "hosted_plugins_changed" }),
    fetch: (async () => { throw new Error("no registry access in this test"); }) as typeof fetch,
  });
  sessions = new WorkspaceSessions(event => bridge?.publish(event), () => undefined, () => false, undefined, undefined, undefined, [], { adapter: integration.adapter, scope });
  await integration.start(); await sessions.open(cwd, "new");
  const retained = sessions.session!, sessionId = retained.sessionManager.getSessionId();
  const { host } = terminalHost(cwd); host.hosted = integration.handlers; host.snapshot = () => sessions.snapshot();
  host.plugins = () => sessions.catalog!.view();
  host.pluginAsset = path => sessions.catalog!.asset(path);
  host.workspaces = async () => ({ items: [{ id: "workspace", title: "Local workspace", path: cwd }], activeId: "workspace", sessions: [{ id: sessionId, workspaceId: "workspace", path: null, name: "Pencil test", modified: new Date().toISOString() }] });
  host.selectSession = async () => {};
  bridge = await startBridge(host, new URL("../../web/dist", import.meta.url).pathname, new NodeTelemetry({ env: { PI_WEB_SENTRY_ENABLED: "false" }, monitor: false }), { pluginSettingsFile: join(root, "plugins.json") });
  const address = new URL(bridge.url), headers = { Authorization: `Bearer ${address.hash.slice(1)}`, Origin: address.origin, "Content-Type": "application/json" };
  const manage = async (operation: string) => {
    const r = await fetch(`${address.origin}/api/hosted-plugins/manage`, { method: "POST", headers, body: JSON.stringify({ pluginId: ID, operation }) });
    expect(r.status, (await r.clone().text()).slice(0, 800)).toBe(200);
  };
  const model = retained.modelRuntime.getModels("openai")[0]!;
  await retained.modelRuntime.setRuntimeApiKey("openai", "fixture-no-network"); await retained.setModel(model);
  let calls = 0;
  /** One agent turn through the retained SDK session: a scripted model, real tool execution. */
  const agent = async (name: string, args: Record<string, unknown>) => {
    const callId = `pencil-${++calls}`; let stage = 0;
    retained.agent.streamFunction = async m => {
      const first = stage++ === 0;
      const message: AssistantMessage = { role: "assistant", api: m.api, provider: m.provider, model: m.id, timestamp: Date.now(), content: first ? [{ type: "toolCall", id: callId, name, arguments: args as ToolCall["arguments"] }] : [{ type: "text", text: "Done" }], stopReason: first ? "toolUse" : "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream(); stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: message.stopReason as "toolUse" | "stop", message }); stream.end(message); return stream;
    };
    await retained.prompt(`pencil step ${callId}`);
    const result = retained.messages.find(message => message.role === "toolResult" && message.toolCallId === callId);
    expect(result?.role === "toolResult" && !result.isError, JSON.stringify(result).slice(0, 600)).toBeTruthy();
    return JSON.parse(((result as { content: { type: string; text?: string }[] }).content.find(c => c.type === "text"))!.text!);
  };
  const errors: string[] = [], external: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== address.origin) external.push(request.url()); });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => { localStorage.setItem("pi-web-locale", "en"); localStorage.setItem("pi-web-theme", "light"); });
  const devState = async () => (JSON.parse(await readFile(statusPath, "utf8").catch(() => "{}")).plugins?.[ID] ?? {}) as { state?: string; version?: string; code?: string; message?: string };
  /** Server-side record of every registered view (controller and authoring mounts). */
  const views = () => [...((integration as any).views.get(ID)?.views.values() ?? [])].map((v: any) => ({ kind: v.kind as string, initialized: v.initialized as boolean, dirty: v.dirty as boolean, busy: v.busy as boolean, frozen: v.frozen as boolean, generation: v.identity.generation as number }));
  /** A developer rebuild of dist/: `edit` may rewrite the backend; resources.json is re-hashed like the real build does. */
  const rebuild = async (edit: (backend: string) => string = s => s) => {
    const runtime = join(plugin, "dist", "runtime.js"), manifestPath = join(plugin, "dist", "resources.json");
    const original = join(root, "runtime.original.js");
    if (!existsSync(original)) await cp(runtime, original);
    const bytes = Buffer.from(edit(await readFile(original, "utf8")) + `\n// rebuild ${Date.now()}\n`);
    await writeFile(runtime, bytes);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const entry = manifest.files.find((f: { path: string }) => f.path === "./dist/runtime.js");
    entry.bytes = bytes.length; entry.sha256 = createHash("sha256").update(bytes).digest("hex");
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  };
  const close = async () => {
    try { await integration.shutdown(); } finally {
      await bridge!.close(); await sessions.dispose();
      if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior;
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  };
  return { bridge, manage, agent, errors, external, devState, views, rebuild, close };
}

const generationOf = async (page: Page, title: string) => Number(new URL((await page.locator(`iframe[title="${title}"]`).getAttribute("src"))!, "http://x").searchParams.get("generation"));
const frameOf = async (page: Page, title: string) => (await page.locator(`iframe[title="${title}"]`).elementHandle())!.contentFrame().then(f => f!);
const nodeByName = (page: Page, title: string, name: string) => frameOf(page, title).then(f => f.evaluate(n => { const g = (globalThis as any).__pencil.editor.graph; for (const node of g.getAllNodes?.() ?? g.nodes.values()) if (node.name === n) return node.id as string; return null; }, name));

pencilTest("pencil in the real host: controller/workspace/editor mounts, freeze→commit remount, freeze→restore", async ({ page }) => {
  test.setTimeout(150_000);
  const h = await pencilHost(page);
  try {
    await h.manage("install"); await h.manage("enable");
    await expect.poll(async () => (await h.devState()).state, { timeout: 30_000 }).toBe("synced");
    const proposal = await h.agent("pencil_propose_changes", { title: "Login", ops: LOGIN });
    expect(proposal.status).toBe("pending_review");

    // Controller: handshake + initialize complete, and it never loads the editor runtime.
    await page.goto(h.bridge.url);
    await expect(page.locator('iframe[title="Pencil controller"]')).toBeAttached();
    await expect.poll(() => h.views().find(v => v.kind === "controller")?.initialized ?? false).toBe(true);

    // Workspace mount from the workbench entry. The frame's handshake must not race the host's
    // one-shot connect (the editor graph has a top-level await).
    await page.getByRole("button", { name: "Open right sidebar" }).click();
    await page.getByRole("button", { name: "Pencil", exact: true }).click();
    const workspace: FrameLocator = page.frameLocator('iframe[title="Pencil workspace"]');
    await expect(workspace.getByTestId("status")).toHaveText("ready", { timeout: 20_000 });
    const controllerAssets = await (await frameOf(page, "Pencil controller")).evaluate(() => performance.getEntriesByType("resource").map(e => e.name).filter(n => /canvaskit|\.wasm|\.ttf/.test(n)));
    expect(controllerAssets, "hidden controller loads no CanvasKit/Yoga/fonts").toEqual([]);

    // Human accepts the agent's proposal through the real view capability.
    await workspace.locator(`[data-proposal="${proposal.proposalId}"] [data-testid="accept"]`).click();
    await expect(workspace.getByTestId("message")).toContainText("Applied “Login” as rev 1");

    // Editor mount: the workspace opens the design in its own tab via the declared panel alias.
    await workspace.getByTestId("open-tab").click();
    const editor = page.frameLocator('iframe[title="Pencil editor"]');
    await expect(editor.getByTestId("status")).toHaveText("ready", { timeout: 20_000 });
    await expect(editor.getByTestId("doc-meta")).toContainText("rev 1");
    await expect.poll(() => h.views().filter(v => v.kind !== "controller").map(v => `${v.kind}:${v.initialized}:${v.dirty}:${v.busy}`).sort()).toEqual(["editor:true:false:false", "workspace:true:false:false"]);

    // 1) Rebuild → freeze barrier → commit → every view remounts on the new generation.
    // A human edit is still inside the editor's 800 ms sync debounce: the freeze must flush it.
    const generation = await generationOf(page, "Pencil workspace");
    const title = await nodeByName(page, "Pencil editor", "Title");
    await (await frameOf(page, "Pencil editor")).evaluate(id => (globalThis as any).__pencil.editor.updateNodeWithUndo(id, { name: "Heading" }), title);
    await h.rebuild();
    await expect.poll(async () => generationOf(page, "Pencil workspace"), { timeout: 30_000 }).toBe(generation + 1);
    await expect.poll(async () => generationOf(page, "Pencil editor")).toBe(generation + 1);
    await expect.poll(async () => (await h.devState()).state).toBe("synced");
    await expect(workspace.getByTestId("status")).toHaveText("ready", { timeout: 20_000 });
    await expect(editor.getByTestId("status")).toHaveText("ready", { timeout: 20_000 });
    await expect(editor.getByTestId("doc-meta")).toContainText("rev 2");
    expect(await nodeByName(page, "Pencil workspace", "Heading"), "the flushed human edit survived the switch").toBe(title);
    await expect.poll(() => h.views().map(v => `${v.kind}@${v.generation}`).sort()).toEqual([`controller@${generation + 1}`, `editor@${generation + 1}`, `workspace@${generation + 1}`]);

    // 2) Rebuild whose backend exposes an unreviewed tool: the switch is refused AFTER the freeze,
    // so the host resumes the old generation and each frozen view is restored, not remounted.
    await h.rebuild(backend => backend.replaceAll('"pencil_status"', '"pencil_statux"'));
    await expect.poll(async () => (await h.devState()).state, { timeout: 30_000 }).toBe("error");
    expect((await h.devState()).message).toMatch(/tool/i);
    expect(await generationOf(page, "Pencil workspace")).toBe(generation + 1);
    await expect(page.locator('iframe[title="Pencil workspace"]')).toHaveCount(1);
    for (const frame of [workspace, editor]) await expect(frame.locator(".shell")).not.toHaveAttribute("data-frozen", /.*/);
    await expect.poll(() => h.views().every(v => !v.frozen)).toBe(true);
    // Restored views are live: a human edit in the workspace syncs and reaches the editor tab.
    const button = await nodeByName(page, "Pencil workspace", "Primary button");
    await (await frameOf(page, "Pencil workspace")).evaluate(id => (globalThis as any).__pencil.editor.updateNodeWithUndo(id, { name: "CTA" }), button);
    await expect(workspace.getByTestId("message")).toContainText("rev 3", { timeout: 10_000 });
    await expect(editor.getByTestId("doc-meta")).toContainText("rev 3", { timeout: 10_000 });
    expect(await nodeByName(page, "Pencil editor", "CTA")).toBe(button);

    // 3) The fixed rebuild switches normally again.
    await h.rebuild();
    await expect.poll(async () => generationOf(page, "Pencil workspace"), { timeout: 30_000 }).toBe(generation + 2);
    await expect(editor.getByTestId("status")).toHaveText("ready", { timeout: 20_000 });
    await expect(editor.getByTestId("doc-meta")).toContainText("rev 3");

    await expect(page.getByText("Pencil lost its connection")).toHaveCount(0);
    expect(h.errors).toEqual([]);
    expect(h.external).toEqual([]);
  } catch (error) {
    // A view that never initialized also blocks a clean shutdown; report the primary failure.
    await h.close().catch(() => {});
    throw error;
  }
  await h.close();
});

pencilTest("pencil in the real host: a person designs by hand in the OpenPencil editor UI, no agent needed", async ({ page }) => {
  test.setTimeout(120_000);
  const h = await pencilHost(page);
  try {
    await h.manage("install"); await h.manage("enable");
    await expect.poll(async () => (await h.devState()).state, { timeout: 30_000 }).toBe("synced");
    await page.goto(h.bridge.url);
    await page.getByRole("button", { name: "Open right sidebar" }).click();
    await page.getByRole("button", { name: "Pencil", exact: true }).click();
    const ws: FrameLocator = page.frameLocator('iframe[title="Pencil workspace"]');
    // The full editor is there before any design exists: menus, pages, layers, toolbar, design panel.
    await expect(ws.getByTestId("status")).toContainText(/No design yet|还没有设计/, { timeout: 20_000 });
    // The host sidebar is narrow, so Pages/Layers is a drawer opened from the canvas corner.
    for (const id of ["toolbar", "design-panel", "tab-design", "toggle-left"]) await expect(ws.getByTestId(id)).toBeVisible();
    await ws.getByTestId("toggle-left").click();
    for (const id of ["left-panel", "pages", "layers"]) await expect(ws.getByTestId(id)).toBeVisible();
    await ws.getByTestId("toggle-left").click();
    await expect(ws.getByTestId("left-panel")).toBeHidden();
    await expect(ws.getByTestId("page-row")).toHaveCount(1);

    // Draw a rectangle with the toolbar: the first edit starts a design of the person's own.
    await ws.getByTestId("tool-rectangle").click();
    const box = (await ws.locator(".op-center canvas").last().boundingBox())!;
    await page.mouse.move(box.x + box.width / 2 - 80, box.y + box.height / 2 - 60);
    await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 30, { steps: 6 }); await page.mouse.up();
    await expect(ws.getByTestId("layer-row")).toHaveCount(1);
    await expect(ws.getByTestId("doc-meta")).toHaveText("rev 1", { timeout: 10_000 });
    const status = await h.agent("pencil_status", {});
    expect(status.designs).toHaveLength(1);
    const docId = status.designs[0].docId as string;
    const rect = (await h.agent("pencil_inspect", { docId })).nodes.find((n: { type: string }) => n.type === "RECTANGLE");
    expect(rect, "the drawn rectangle reached the authoritative backend").toBeTruthy();

    // Edit it in the design panel: width through the number field, fill through the hex field.
    await expect(ws.locator('.op-panel-header')).toContainText(/Rectangle/);
    const width = ws.locator('.op-num[title="W"], .op-num[title="Width"], .op-num[title="宽度"]').first();
    await width.click(); await width.locator("input").fill("200"); await width.locator("input").press("Enter");
    await ws.locator(".op-psection", { hasText: /^Fill|填充/ }).locator(".op-hex").first().fill("16A34A");
    await ws.locator(".op-psection", { hasText: /^Fill|填充/ }).locator(".op-hex").first().press("Enter");
    await expect.poll(async () => (await h.agent("pencil_inspect", { docId })).nodes.find((n: { id: string }) => n.id === rect.id)?.w, { timeout: 10_000 }).toBe(200);
    const fill = await (await frameOf(page, "Pencil workspace")).evaluate(id => (globalThis as any).__pencil.editor.graph.getNode(id).fills[0].color, rect.id);
    expect([fill.r, fill.g, fill.b].map((v: number) => Math.round(v * 255))).toEqual([0x16, 0xa3, 0x4a]);

    // Rename the design from its name, then start a second one from the designs menu.
    await ws.getByTestId("toggle-left").click();
    await ws.getByTestId("doc-name").dblclick();
    await ws.locator("[data-doc-rename]").fill("Signup"); await ws.locator("[data-doc-rename]").press("Enter");
    await expect(ws.getByTestId("doc-name")).toHaveText("Signup");
    await expect.poll(async () => (await h.agent("pencil_status", {})).designs[0].untrusted.title).toBe("Signup");
    await ws.getByTestId("designs").click();
    await ws.getByTestId("new-design").click();
    await expect.poll(async () => (await h.agent("pencil_status", {})).designs.length).toBe(2);
    await expect(ws.getByTestId("layer-row")).toHaveCount(0);
    await ws.getByTestId("designs").click();
    await ws.getByRole("menuitem", { name: "Signup" }).click();
    await expect(ws.getByTestId("layer-row")).toHaveCount(1);
    await page.screenshot({ path: test.info().outputPath("manual-design-sidebar.png") });
    // Full width: Pages/Layers and the design panel dock beside the canvas, as in OpenPencil.
    await page.getByRole("button", { name: "Fullscreen" }).click();
    await expect(ws.getByTestId("toggle-left")).toHaveCount(0);
    await expect(ws.getByTestId("left-panel")).toBeVisible();
    await ws.getByTestId("layer-row").first().click();
    await expect(ws.locator(".op-panel-header")).toContainText(/Rectangle/);
    await page.screenshot({ path: test.info().outputPath("manual-design-full.png") });

    // The agent can work on the person's design like any other.
    const proposal = await h.agent("pencil_propose_changes", { docId, baseRev: (await h.agent("pencil_inspect", { docId })).rev, title: "Round it", ops: [{ op: "update", id: rect.id, props: { radius: 16 } }] });
    expect(proposal.status).toBe("pending_review");
    expect(h.errors).toEqual([]);
    expect(h.external).toEqual([]);
  } catch (error) {
    await h.close().catch(() => {});
    throw error;
  }
  await h.close();
});
