import { test, expect } from "@playwright/test";
import { mkdtemp, realpath, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir, cpus, platform, release, arch, totalmem } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { build } from "esbuild";
import { HostedPluginIntegration } from "../../src/host/server/plugins/hosted/integration.ts";
import { WorkspaceSessions } from "../../src/host/server/sessions/workspace-sessions.ts";
import { HostedStateBroker } from "../../src/host/server/plugins/hosted/state-broker.ts";
import { startBridge, type Bridge } from "../../src/host/server/transport/bridge.ts";
import { NodeTelemetry } from "../../src/platform/telemetry/telemetry.ts";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { localRelease } from "../helpers/hosted-local-release.ts";
import { installLifecycleProbe } from "../helpers/hosted-lifecycle-probe.ts";
import { terminalHost } from "../helpers/terminal-host.ts";

const id = "@chengzhiyi/pi-excalidraw";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const percentile = (values: number[], fraction: number) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1]!;

/** Opt-in, relatively expensive reference measurement. It never downloads a registry release.
 * Different local synthetic versions of the exact archive isolate switching from install time.
 * Includes complete host App, real worker, controller/tool/editor realms and retained SDK.
 * Not a paired host upgrade, public release upgrade or long-term leak certification.
 */
test("100-element local switch: 20 warmups + 50 different-version controller/editor/worker cycles", async ({ page, browserName }, info) => {
  test.skip(!process.env.HOSTED_EXCALIDRAW_TGZ || process.env.HOSTED_STRESS !== "1", "Explicit exact archive and HOSTED_STRESS=1 required");
  test.setTimeout(600_000); page.setDefaultTimeout(12_000);
  const root = await realpath(await mkdtemp(join(tmpdir(), "hosted-stress-")));
  const previous = process.env.PI_CODING_AGENT_DIR, previousRoots = process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent"); process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS = "";
  let bridge: Bridge | undefined, sessions!: WorkspaceSessions;
  const workerEntry = join(root, "worker.mjs"), hostedRoot = join(root, "hosted");
  await build({ entryPoints: [new URL("../../src/host/server/plugins/hosted/worker-entry.ts", import.meta.url).pathname], outfile: workerEntry, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
  const scope = (cwd: string, sessionId: string) => ({ cwd, sessionId, workspaceId: "reference" });
  const integration = new HostedPluginIntegration({ root: hostedRoot, workerEntry, hostVersion: "0.1.29", ownerId: "local-stress-principal",
    resolveSession: sessionId => { const value = sessions?.hostedScope(sessionId); return value ? scope(value.cwd, sessionId) : null; },
    changed: () => bridge?.publish({ type: "hosted_plugins_changed" }),
    fetch: (async () => { throw new Error("Reference benchmark forbids registry access"); }) as typeof fetch });
  sessions = new WorkspaceSessions(event => bridge?.publish(event), () => undefined, () => false, undefined, undefined, undefined, [], { adapter: integration.adapter, scope });
  const errors: string[] = [], external: string[] = [], observedPids = new Set<number>();
  const broker = new HostedStateBroker(join(hostedRoot, "data"), id);
  try {
    await integration.start(); await sessions.open(root, "new");
    const retained = sessions.session!, sessionId = retained.sessionManager.getSessionId();
    const bytes = await readFile(process.env.HOSTED_EXCALIDRAW_TGZ!);
    // Real loopback TCP transfer, measured separately; never label this internet/registry latency.
    const downloadServer = createServer((_request, response) => { response.writeHead(200, { "Content-Length": bytes.length }); response.end(bytes); });
    await new Promise<void>(resolve => downloadServer.listen(0, "127.0.0.1", resolve));
    let loopbackDownloadMs: number;
    try {
      const start = performance.now(), port = (downloadServer.address() as import("node:net").AddressInfo).port;
      const downloaded = Buffer.from(await (await fetch(`http://127.0.0.1:${port}/archive.tgz`, { signal: AbortSignal.timeout(10_000) })).arrayBuffer());
      loopbackDownloadMs = performance.now() - start; expect(downloaded.equals(bytes)).toBe(true);
    } finally { await new Promise<void>((resolve, reject) => downloadServer.close(error => error ? reject(error) : resolve())); }
    const installStart = performance.now();
    await integration.manager.installer.installArchive(id, bytes, "sha512-" + createHash("sha512").update(bytes).digest("base64"), "0.1.0");
    const archiveInstallMs = performance.now() - installStart;
    await integration.manage({ pluginId: id, operation: "enable" });
    const { host } = terminalHost(root); host.hosted = integration.handlers; host.snapshot = () => sessions.snapshot();
    host.workspaces = async () => ({ items: [{ id: "reference", title: "Local workspace", path: root }], activeId: "reference", sessions: [{ id: sessionId, workspaceId: "reference", path: null, name: "Stress session", modified: new Date().toISOString() }] });
    host.selectSession = async () => {};
    bridge = await startBridge(host, new URL("../../web/dist", import.meta.url).pathname, new NodeTelemetry({ env: { PI_WEB_SENTRY_ENABLED: "false" }, monitor: false }), { pluginSettingsFile: join(root, "plugins.json") });
    const address = new URL(bridge.url), headers = { Authorization: "Bearer " + address.hash.slice(1), Origin: address.origin, "Content-Type": "application/json" };
    const action = async (action: string, input: unknown) => {
      const response = await fetch(address.origin + "/api/hosted-plugins/action", { method: "POST", headers, body: JSON.stringify({ pluginId: id, generation: (await broker.active())!.generation, sessionId, action, input }) });
      expect(response.status).toBe(200); return response.json();
    };
    // Request native shapes/Chinese/viewport, verify validated import fidelity, then
    // compare the full persisted checkpoint after every switch. Native gesture/render
    // fidelity is covered separately by the synchronized A06 canvas-pixel regression.
    const scene = { type: "excalidraw", version: 2, source: "pi-webapp", files: {},
      appState: { viewBackgroundColor: "#ffffff", scrollX: 31, scrollY: 47, zoom: { value: 0.75 } },
      elements: Array.from({ length: 100 }, (_, i) => ({ id: "element-" + i, type: i === 99 ? "text" : "rectangle", x: i % 10 * 120, y: Math.floor(i / 10) * 80, width: 100, height: 60,
        groupIds: ["group-" + Math.floor(i / 10)], strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "hachure", strokeWidth: 1, roughness: 1, opacity: 100,
        seed: i + 1, version: 1, versionNonce: i + 1, isDeleted: false, angle: 0, boundElements: [], updated: 1, link: null, locked: false,
        ...(i === 99 ? { text: "中文基准", originalText: "中文基准", fontSize: 20, fontFamily: 5, textAlign: "left", verticalAlign: "top", containerId: null, autoResize: true, lineHeight: 1.25 } : {}) })) };
    const model = retained.modelRuntime.getModels("openai")[0]!;
    await retained.modelRuntime.setRuntimeApiKey("openai", "fixture-no-network"); await retained.setModel(model);
    let stage = 0;
    retained.agent.streamFunction = async model => {
      const first = stage++ === 0;
      const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: first ? [{ type: "toolCall", id: "stress-draw", name: "excalidraw_create_view", arguments: { title: "100 elements / 中文", elements: JSON.stringify(scene.elements.map(e => ({ type: e.type, id: e.id, x: e.x, y: e.y, width: e.width, height: e.height, ...(e.type === "text" ? { text: "中文基准" } : {}) }))) } }] : [{ type: "text", text: "Ready" }], stopReason: first ? "toolUse" : "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream(); stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: first ? "toolUse" : "stop", message }); stream.end(message); return stream;
    };
    await retained.prompt("Draw a local 100-element diagram");
    const result = retained.messages.find(message => message.role === "toolResult" && message.toolCallId === "stress-draw");
    expect(result?.role === "toolResult" && !result.isError, JSON.stringify(result)).toBeTruthy();
    const draft = { id: (result as any).details.id };
    const proposed = await action("get", { id: draft.id });
    await action("accept", { id: draft.id, revision: proposed.revision, candidateId: proposed.candidate.id, scene });
    const before = await action("get", { id: draft.id }); let expectedHash = hash(before);
    expect(before.scene.elements).toHaveLength(100);
    expect(before.scene.elements.at(-1).text).toBe("中文基准");
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== address.origin) external.push(request.url()); });
    const lifecycle: Array<{ url: string; intervals: number; windowListeners: number }> = [];
    page.on("console", message => { if (message.text().startsWith("ORI40_LIFECYCLE ")) lifecycle.push(JSON.parse(message.text().slice(16))); });
    await page.addInitScript(installLifecycleProbe);
    await page.addInitScript(() => { localStorage.setItem("pi-web-locale", "en"); });
    await page.goto(bridge.url);
    const boot = await page.evaluate(() => { const value = crypto.randomUUID(); (window as any).__stressBoot = value; return value; });
    const waitReady = async (generation: number) => {
      await expect(page.locator('iframe[title="Excalidraw controller"]')).toHaveCount(1);
      await expect.poll(() => {
        const coordinators = [...(integration as any).views.values()];
        return coordinators.length === 1 && coordinators[0].views.size === 3 && [...coordinators[0].views.values()].every((view: any) => view.identity.generation === generation && !view.busy);
      }, { timeout: 12_000 }).toBe(true);
      await expect(page.locator(`iframe[title="Excalidraw controller"][src*="generation=${generation}"]`)).toHaveCount(1);
    };
    await page.getByRole("button", { name: "Stress session", exact: true }).click();
    // Do not retain a Playwright remote iframe handle in the debugger during a GC census.
    await expect.poll(() => page.evaluate(() => !!document.querySelector<HTMLIFrameElement>('iframe[title="Excalidraw tool"]')?.contentDocument?.querySelector('[aria-label="Edit Excalidraw"]'))).toBe(true);
    await page.evaluate(() => document.querySelector<HTMLIFrameElement>('iframe[title="Excalidraw tool"]')!.contentDocument!.querySelector<HTMLButtonElement>('[aria-label="Edit Excalidraw"]')!.click());
    await expect(page.frameLocator('iframe[title="Excalidraw editor"]').locator("canvas.interactive")).toBeVisible();
    await waitReady((await broker.active())!.generation);
    await expect.poll(async () => (await action("get", { id: draft.id })).revision).toBeGreaterThan(before.revision);
    expectedHash = hash(await action("get", { id: draft.id }));
    const cdp = await page.context().newCDPSession(page); await cdp.send("Performance.enable");
    const samples: number[] = [], heaps: number[] = [], hostRss: number[] = [], installs: number[] = [], childSamples: string[] = [], resources: unknown[] = [];
    const destroyedContexts = new Set<number>();
    cdp.on("Runtime.executionContextDestroyed", event => destroyedContexts.add(event.executionContextId));
    await cdp.send("Runtime.enable");
    const cpuBefore = process.cpuUsage(); const elapsedStart = performance.now();
    for (let i = 0; i < 70; i++) {
      const supervisor = (integration.manager as any).supervisors.get(id);
      // Private test inspection is deliberate; production does not expose process handles.
      const oldPid: number | undefined = supervisor.pid;
      // Local synthetic immutable versions of the actual plugin payload, not public releases.
      const version = `0.1.${i + 1}`, candidate = localRelease(bytes, version);
      const installStart = performance.now();
      await integration.manager.installer.installArchive(id, candidate, "sha512-" + createHash("sha512").update(candidate).digest("base64"), version);
      installs.push(performance.now() - installStart);
      if (oldPid) childSamples.push(execFileSync("ps", ["-p", String(oldPid), "-o", "pid=,time=,%cpu=,rss="], { encoding: "utf8" }).trim());
      await page.evaluate(() => (window as any).__ori40.capture());
      const lifecycleBefore = lifecycle.length;
      const start = performance.now();
      const response = await fetch(address.origin + "/api/hosted-plugins/manage", { method: "POST", headers, body: JSON.stringify({ pluginId: id, operation: "enable", version, reopenEditors: true }) });
      expect(response.status).toBe(200);
      const catalog = await response.json(); const generation = catalog.plugins[0].generation;
      await waitReady(generation);
      await expect(page.frameLocator('iframe[title="Excalidraw editor"]').locator("canvas.interactive")).toBeVisible();
      const ms = performance.now() - start;
      expect(lifecycle.slice(lifecycleBefore)).toHaveLength(3);
      for (const disposed of lifecycle.slice(lifecycleBefore)) { expect(disposed.intervals).toBe(0); expect(disposed.windowListeners).toBe(0); }
      expect(hash(await action("get", { id: draft.id }))).toBe(expectedHash);
      expect(sessions.session).toBe(retained);
      expect(await page.evaluate(() => (window as any).__stressBoot)).toBe(boot);
      expect(integration.manager.tools[0]!.descriptors).toHaveLength(6);
      expect(new Set(integration.manager.tools[0]!.descriptors.map(tool => tool.name)).size).toBe(6);
      if (oldPid) { observedPids.add(oldPid); expect(() => process.kill(oldPid, 0)).toThrow(); }
      if (i >= 20) {
        samples.push(ms);
        // DevTools retains console-associated DOM nodes (including Chromium autofocus warnings).
        // Remove debugger-owned references, not application references, before the census.
        await cdp.send("Runtime.discardConsoleEntries");
        await cdp.send("HeapProfiler.collectGarbage");
        const metrics = await cdp.send("Performance.getMetrics");
        heaps.push(metrics.metrics.find(value => value.name === "JSHeapUsedSize")!.value);
        hostRss.push(process.memoryUsage().rss);
        const resource = await page.evaluate(() => (window as any).__ori40.sample());
        resources.push(resource);
        expect(resource.openPorts).toBe(3);
        // Retain actual detached references in the report; apply the zero-retention gate only AFTER attaching all 50 samples.
      }
    }
    const active = (await broker.active())!;
    expect(await readdir(join(broker.root, "states"))).toHaveLength(2);
    expect((await integration.manager.installer.inventory()).versions[id]).toHaveLength(2); // Current and previous immutable versions, bounded by real GC.
    const first = percentile(heaps.slice(0, 10), 0.5), last = percentile(heaps.slice(-10), 0.5);
    // Explicit bounded-growth smoke budget, NOT a promise that GC returns RSS to baseline.
    expect(last - first).toBeLessThan(first * 0.25 + 8 * 1024 * 1024);
    expect(errors).toEqual([]); expect(external).toEqual([]);
    const report = { environment: { node: process.version, browserName, browserVersion: page.context().browser()!.version(), os: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem() },
      scope: "Complete host App + real HTTP + retained SDK + real worker + controller and 100-element editor realm; 70 different synthetic local versions of actual plugin payload; no provider/network download",
      archiveSha256: createHash("sha256").update(bytes).digest("hex"), archiveBytes: bytes.length, archiveInstallMs, sceneElements: 100, checkpointHash: expectedHash,
      warmups: 20, measuredCycles: samples.length, ms: { p50: percentile(samples, 0.5), p95: percentile(samples, 0.95), max: Math.max(...samples), samples },
      designTargetP95Ms: 2000, designTargetMet: percentile(samples, 0.95) <= 2000,
      localInstallMs: { samples: installs, p95: percentile(installs, 0.95) }, networkDownload: { transport: "loopback HTTP/TCP, not registry/internet", bytes: bytes.length, ms: loopbackDownloadMs! }, registryDownloadMs: null,
      childPsColumns: "pid cumulative-CPU-time lifetime-%CPU RSS-KiB", childSamples,
      lifecycle, parentResources: resources, destroyedExecutionContexts: destroyedContexts.size,
      parentCpuMicroseconds: process.cpuUsage(cpuBefore), wallMs: performance.now() - elapsedStart,
      parentRssBytes: { min: Math.min(...hostRss), max: Math.max(...hostRss), last: hostRss.at(-1) },
      browserPostGcHeapBytes: { firstMedian: first, lastMedian: last, growth: last - first, samples: heaps },
      oldWorkerPidsConfirmedExited: observedPids.size, generation: active.generation, activeFrames: 3, activeTools: 6, retainedStateSnapshots: 2, externalRequests: external.length, pageErrors: errors.length,
      limitations: ["Different local synthetic versions with identical editor/backend payload; not public upstream releases", "Child ps samples are pre-switch lifetime CPU/RSS snapshots, not peak or precise per-operation CPU", "Explicit plugin window listeners/intervals and parent port closure are observed; context destruction covers remaining realm resources, not an exhaustive OS handle census", "WeakRef detached iframe census after forced GC and Runtime.discardConsoleEntries excludes DevTools console roots, not application roots; not a proof against every possible parent reference", "Loopback TCP download is measured separately from installation; registry/internet latency remains unmeasured",  "Accepted native 100-element scene/viewport/Chinese and full checkpoint hash checked after initial native normalization; held gesture/render fidelity tested separately", "No held editor gesture, provider stream or Electron/other-platform certification", "Browser heap budget is smoke-only; not an exhaustive leak proof"] };
    expect(observedPids.size).toBe(70);
    await info.attach("reference-measurement.json", { body: JSON.stringify(report, null, 2), contentType: "application/json" });
    console.log(JSON.stringify(report, null, 2));
    if ((resources.at(-1) as any).detachedFramesRetained.length) {
      const chunks: string[] = []; cdp.on("HeapProfiler.addHeapSnapshotChunk", event => chunks.push(event.chunk));
      await cdp.send("HeapProfiler.takeHeapSnapshot");
      await writeFile(info.outputPath("retained.heapsnapshot"), chunks.join(""));
    }
    expect((resources.at(-1) as any).detachedFramesRetained, "Detached parent iframe references after post-GC; investigate rather than hiding retention").toHaveLength(0);
    expect(report.designTargetMet, "Reference design P95 <=2s; retain measurements on failure, do not weaken target").toBe(true);
  } finally {
    await integration.shutdown(); await page.close(); await bridge?.close(); await sessions.dispose();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    if (previousRoots === undefined) delete process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS; else process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS = previousRoots;
    await rm(root, { recursive: true, force: true });
  }
});
