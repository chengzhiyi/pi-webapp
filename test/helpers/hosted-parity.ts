import { test, expect, type Page } from "@playwright/test";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { HostedAgentPolicy } from "../../src/host/server/plugins/hosted/agent-adapter.ts";
import { legacyCheckpointLoader } from "../../src/host/server/plugins/hosted/legacy-checkpoints.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { build } from "esbuild";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { HostedPluginIntegration } from "../../src/host/server/plugins/hosted/integration.ts";
import { WorkspaceSessions } from "../../src/host/server/sessions/workspace-sessions.ts";
import { startBridge, type Bridge } from "../../src/host/server/transport/bridge.ts";
import { NodeTelemetry } from "../../src/platform/telemetry/telemetry.ts";
import { terminalHost } from "./terminal-host.ts";
import { integrationFixture } from "./hosted-integration-fixture.ts";

export const pluginId = "@chengzhiyi/pi-excalidraw";
// Synthetic local upgrade of the exact payload; never evidence of an upstream release.
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

/** Complete built App, authenticated bridge, actual child worker/archive, retained SDK session.
 * Only registry and provider transports are deterministic. No action/flush success is mocked.
 */
export async function hostedParity(page: Page, options: { width?: number; locale?: "zh" | "en"; theme?: "light" | "dark";
  v1Archive?: string; installDrawing?: boolean; policy?: () => Omit<HostedAgentPolicy, "enabled">;
  seed?: (context: { root: string; retained: AgentSession; sessionId: string }) => Promise<void>;
} = {}) {
  page.setDefaultTimeout(12_000);
  const root = await realpath(await mkdtemp(join(tmpdir(), "hosted-parity-")));
  const prior = process.env.PI_CODING_AGENT_DIR, roots = process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent"); process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS = "";
  if (options.v1Archive) {
    const destination = join(root, "v1"); await mkdir(destination);
    await promisify(execFile)("tar", ["-xzf", options.v1Archive, "-C", destination]);
    // The independently packed extension/client are unmodified. Resolve only runtime peers
    // from this task's isolated host install, never the parent's dependency tree.
    await symlink(new URL("../../node_modules", import.meta.url).pathname, join(destination, "package/node_modules"), "dir");
    process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS = join(destination, "package");
  }
  const bytes = await readFile(process.env.HOSTED_EXCALIDRAW_TGZ!);
  let selected = bytes, version = "0.1.0", bridge: Bridge | undefined, sessions!: WorkspaceSessions;
  const workerEntry = join(root, "worker.mjs");
  await build({ entryPoints: [new URL("../../src/host/server/plugins/hosted/worker-entry.ts", import.meta.url).pathname], outfile: workerEntry, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
  const scope = (cwd: string, sessionId: string) => ({ cwd, sessionId, workspaceId: "workspace" });
  const integration = new HostedPluginIntegration({ root: join(root, "hosted"), workerEntry, hostVersion: "0.1.29", ownerId: "local-test-principal",
    resolveSession: sessionId => { const retained = sessions?.hostedScope(sessionId); return retained ? scope(retained.cwd, sessionId) : null; },
    policy: options.policy,
    legacy: () => legacyCheckpointLoader(join(root, "legacy")),
    changed: () => bridge?.publish({ type: "hosted_plugins_changed" }),
    fetch: (async (url: string | URL | Request) => String(url).endsWith(".tgz") ? new Response(selected) : new Response(JSON.stringify({ versions: { [version]: { ...integrationFixture().release, version, dist: { tarball: `https://registry.npmjs.org/local-${version}.tgz`, integrity: "sha512-" + createHash("sha512").update(selected).digest("base64") } } } }))) as typeof fetch,
  });
  sessions = new WorkspaceSessions(event => bridge?.publish(event), () => undefined, () => false, undefined, undefined, undefined, [], { adapter: integration.adapter, scope });
  await integration.start(); await sessions.open(root, "new");
  const retained = sessions.session!, sessionId = retained.sessionManager.getSessionId();
  await options.seed?.({ root, retained, sessionId });
  const { host } = terminalHost(root); host.hosted = integration.handlers; host.snapshot = () => sessions.snapshot();
  host.plugins = () => sessions.catalog!.view();
  host.pluginAsset = path => sessions.catalog!.asset(path);
  host.invokePluginAction = (sessionId, pluginId, action, input) => sessions.invokePluginAction({ requestId: crypto.randomUUID(), sessionId, pluginId, action, input });
  host.resolvePluginInteraction = async (sessionId, pluginId, requestId, value) => sessions.resolveInteraction(sessionId, pluginId, requestId, value);
  let sends = 0;
  host.send = (_id, text, images, correlation, delivery) => { sends++; return sessions.send(text, images, correlation, delivery); };
  host.workspaces = async () => ({ items: [{ id: "workspace", title: "Local workspace", path: root }], activeId: "workspace", sessions: [{ id: sessionId, workspaceId: "workspace", path: null, name: "Hosted test", modified: new Date().toISOString() }] });
  host.selectSession = async () => {};
  bridge = await startBridge(host, new URL("../../web/dist", import.meta.url).pathname, new NodeTelemetry({ env: { PI_WEB_SENTRY_ENABLED: "false" }, monitor: false }), { pluginSettingsFile: join(root, "plugins.json") });
  const address = new URL(bridge.url), headers = { Authorization: `Bearer ${address.hash.slice(1)}`, Origin: address.origin, "Content-Type": "application/json" };
  const card = () => integration.inventory().then(value => value.plugins[0]!);
  const rawAction = async (action: string, input = {}, generation?: number) => fetch(address.origin + "/api/hosted-plugins/action", { method: "POST", headers, body: JSON.stringify({ pluginId, generation: generation ?? (await card()).generation, sessionId, action, input }) });
  const action = async (name: string, input = {}): Promise<any> => { const response = await rawAction(name, input); expect(response.status, await response.clone().text()).toBe(200); return response.json(); };
  const manage = async (action: string, extra = {}) => { const response = await fetch(address.origin + "/api/hosted-plugins/manage", { method: "POST", headers, body: JSON.stringify({ pluginId, operation: action, ...extra }) }); expect(response.status, await response.clone().text()).toBe(200); return response.json(); };
  const errors: string[] = [], external: string[] = [], actions: unknown[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (request.url().endsWith('/api/hosted-plugins/action')) actions.push({ at: Date.now(), action: request.postDataJSON()?.action }); });
  page.on("response", async response => { if (response.url().endsWith('/api/hosted-plugins/action')) { const data = await response.json().catch(() => null); actions.push({ at: Date.now(), status: response.status(), revision: data?.revision, candidate: data?.candidate?.id, error: data?.error }); } });
  page.on("request", request => { if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== address.origin) external.push(request.url()); });
  await page.setViewportSize({ width: options.width ?? 1440, height: 1000 });
  await page.addInitScript(({ locale, theme }) => { localStorage.setItem("pi-web-locale", locale); localStorage.setItem("pi-web-theme", theme); Reflect.deleteProperty(window, "showSaveFilePicker"); Reflect.deleteProperty(window, "showOpenFilePicker"); }, { locale: options.locale ?? "en", theme: options.theme ?? "light" });
  if (options.installDrawing !== false) { await manage("install"); await manage("enable"); }
  const model = retained.modelRuntime.getModels("openai")[0]!;
  await retained.modelRuntime.setRuntimeApiKey("openai", "fixture-no-network"); await retained.setModel(model);
  host.models = () => [{ provider: model.provider, id: model.id, name: model.name }];
  let invocation = 0;
  const tool = async (name: string, args: Record<string, any>, expectError = false) => {
    const callId = `parity-${++invocation}`; let stage = 0;
    retained.agent.streamFunction = async model => {
      const first = stage++ === 0;
      const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: first ? [{ type: "toolCall", id: callId, name, arguments: args }] : [{ type: "text", text: "Ready" }], stopReason: first ? "toolUse" : "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream(); stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: first ? "toolUse" : "stop", message }); stream.end(message); return stream;
    };
    await retained.prompt("Local parity drawing operation");
    const result = retained.messages.find(message => message.role === "toolResult" && message.toolCallId === callId);
    expect(result?.role === "toolResult" && result.isError === expectError, JSON.stringify(result)).toBeTruthy();
    return (result as any).details;
  };
  const open = async (target = page) => {
    await expect(target.locator('iframe[title="Excalidraw tool"]').first()).toBeAttached();
    const preview = target.frameLocator('iframe[title="Excalidraw tool"]').first();
    await expect(preview.getByRole("img")).toBeVisible({ timeout: 15_000 });
    await preview.getByRole("button", { name: options.locale === "zh" ? "编辑 Excalidraw" : "Edit Excalidraw", exact: true }).click();
    const editor = target.frameLocator('iframe[title="Excalidraw editor"]');
    await expect(editor.locator("canvas.interactive")).toBeVisible(); return editor;
  };
  const close = async () => {
    for (const [i, p] of (page.context().browser()?.contexts().flatMap(c => c.pages()) ?? page.context().pages()).entries()) {
      await p.screenshot({ path: test.info().outputPath(`last-page-${i}.png`) }).catch(() => {});
      const diagnostic = test.info().outputPath(`frame-diagnostics-${i}.json`);
      await writeFile(diagnostic, JSON.stringify({ actions, frames: await Promise.all(p.frames().map(async f => ({ url: f.url().split('#')[0].replace(/(\/hosted-plugins\/).*?(\/dist\/)/, '$1[archive]$2'), timing: await f.evaluate(() => performance.getEntriesByType("resource").filter(e => e.name.includes("/api/hosted-plugins/")).map(e => { const r = e as PerformanceResourceTiming; return { name: new URL(r.name).pathname, start: r.startTime, queued: r.requestStart - r.fetchStart, response: r.responseStart - r.requestStart, duration: r.duration }; })).catch(() => []), text: await f.locator('body').innerText().catch(() => '') }))) }, null, 2));
      await test.info().attach(`frame-diagnostics-${i}`, { path: diagnostic, contentType: "application/json" });
    }
    try {
      // A persisted action result precedes its realm's HTTP busy=false report.
      // Wait for genuine initialization/mutation quiescence before requesting
      // normal shutdown. A stuck view still fails, and shutdown/real freeze ACKs
      // are attempted even when the readiness assertion fails.
      try {
        await expect.poll(() => [...(integration as any).views.values()].every((coordinator: any) =>
          [...coordinator.views.values()].every((view: any) => !view.busy)), { timeout: 10_000, message: "All registered realms must acknowledge readiness before shutdown" }).toBe(true);
      } finally { await integration.shutdown(); }
    } catch (error) {
      // Preserve the primary assertion and record secondary fail-closed teardown separately.
      // This is NOT a successful flush or lifecycle pass, even when body assertions pass.
      const text = error instanceof Error ? error.stack ?? error.message : String(error);
      test.info().annotations.push({ type: "shutdown-failed-closed", description: text });
      const path = test.info().outputPath("shutdown-failed-closed.txt"); await writeFile(path, text);
      await test.info().attach("shutdown-failed-closed", { path, contentType: "text/plain" });
      console.error("TEARDOWN (not a successful flush):", error);
      throw error; // A passing body is not lifecycle acceptance without real shutdown.
    } finally {
      for (const c of page.context().browser()?.contexts() ?? [page.context()]) for (const p of c.pages()) await p.close();
      await bridge!.close(); await sessions.dispose();
      if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior;
      if (roots === undefined) delete process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS; else process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS = roots;
      await rm(root, { recursive: true, force: true });
    }
  };
  return { root, bridge, sessionId, retained, sessions, integration, card, action, rawAction, manage, tool, open, close, errors, external, sends: () => sends,
    upgrade: () => { version = "0.1.1"; selected = localRelease(bytes, version); },
    upgradeArchive: (archive: Buffer, nextVersion = "0.1.1") => { version = nextVersion; selected = Buffer.from(archive); },
  };
}

export const boxes = (count = 1) => ({ title: "中文分组画布", elements: JSON.stringify(Array.from({ length: count }, (_, i) => ({ type: "rectangle", id: `box-${i}`, x: (i % 10) * 150, y: Math.floor(i / 10) * 100, width: 120, height: 70, groupIds: [`group-${Math.floor(i / 5)}`], backgroundColor: i % 2 ? "#dbeafe" : "transparent" }))) });
