import { expect, type Page } from "@playwright/test";
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
import { terminalHost } from "./terminal-host.ts";

// pi-pencil inside the REAL host client. The built App's HostedFrame drives FrameAdapter and
// HostedViewClient (register → MessagePort handshake on iframe load → initialize → long poll) for
// the controller, workspace and editor mounts the workbench creates. The plugin is a developer
// root wired exactly as pi-host wires `hosted-dev.json`, so a rebuild runs the serialized `update`
// switch: every authoring view must answer the server's freeze barrier, then remount on commit,
// or be restored when the switch is cancelled after the freeze. Nothing in the view protocol is
// mocked; only the model stream is scripted.
// Needs a built plugin: PI_PENCIL_ROOT=<pi-extensions>/packages/pencil (with dist/).
export const PENCIL_ID = "@chengzhiyi/pi-pencil";
const ID = PENCIL_ID;
export const pencilSource = process.env.PI_PENCIL_ROOT ?? new URL("../../../pi-extensions/packages/pencil", import.meta.url).pathname;
const source = pencilSource;
/** True when a built plugin is present; without one, Pencil browser specs are not registered at all. */
export const pencilBuilt = existsSync(join(source, "dist", "frame.html"));

export async function pencilHost(page: Page, options: { sessionName?: string } = {}) {
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
  host.workspaces = async () => ({ items: [{ id: "workspace", title: "Local workspace", path: cwd }], activeId: "workspace", sessions: [{ id: sessionId, workspaceId: "workspace", path: null, name: options.sessionName ?? "Pencil test", modified: new Date().toISOString() }] });
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
  const agent = async (name: string, args: Record<string, unknown>, text: { prompt?: string; reply?: string } = {}) => {
    const callId = `pencil-${++calls}`; let stage = 0;
    retained.agent.streamFunction = async m => {
      const first = stage++ === 0;
      const message: AssistantMessage = { role: "assistant", api: m.api, provider: m.provider, model: m.id, timestamp: Date.now(), content: first ? [{ type: "toolCall", id: callId, name, arguments: args as ToolCall["arguments"] }] : [{ type: "text", text: text.reply ?? "Done" }], stopReason: first ? "toolUse" : "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream(); stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: message.stopReason as "toolUse" | "stop", message }); stream.end(message); return stream;
    };
    await retained.prompt(text.prompt ?? `pencil step ${callId}`);
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
