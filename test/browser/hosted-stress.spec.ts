import { test, expect } from "@playwright/test";
import { mkdtemp, realpath, readFile, rm, readdir } from "node:fs/promises";
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
import { terminalHost } from "../helpers/terminal-host.ts";

const id = "@chengzhiyi/pi-excalidraw";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const percentile = (values: number[], fraction: number) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1]!;

/** Opt-in, relatively expensive reference measurement. It never downloads a registry release.
 * A staged SAME-version replacement isolates local switching from network/install time.
 * It exercises the complete host App, controller realm, retained SDK and real plugin worker,
 * but does not certify a paired application upgrade, active editor or cross-version heap budget.
 */
test("100-element local switch: 20 warmups + 50 complete-host controller/worker cycles", async ({ page, browserName }, info) => {
  test.skip(!process.env.HOSTED_EXCALIDRAW_TGZ || process.env.HOSTED_STRESS !== "1", "Explicit exact archive and HOSTED_STRESS=1 required");
  test.setTimeout(240_000);
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
    const installStart = performance.now();
    await integration.manager.installer.installArchive(id, bytes, "sha512-" + createHash("sha512").update(bytes).digest("base64"), "0.1.0");
    const archiveInstallMs = performance.now() - installStart;
    await integration.manage({ pluginId: id, operation: "enable" });
    const { host } = terminalHost(root); host.hosted = integration.handlers; host.snapshot = () => sessions.snapshot();
    bridge = await startBridge(host, new URL("../../web/dist", import.meta.url).pathname, new NodeTelemetry({ env: { PI_WEB_SENTRY_ENABLED: "false" }, monitor: false }), { pluginSettingsFile: join(root, "plugins.json") });
    const address = new URL(bridge.url), headers = { Authorization: "Bearer " + address.hash.slice(1), Origin: address.origin, "Content-Type": "application/json" };
    const action = async (action: string, input: unknown) => {
      const response = await fetch(address.origin + "/api/hosted-plugins/action", { method: "POST", headers, body: JSON.stringify({ pluginId: id, generation: (await broker.active())!.generation, sessionId, action, input }) });
      expect(response.status).toBe(200); return response.json();
    };
    // Valid native scene including grouped shapes and Chinese text; immutable data is compared
    // byte-for-byte after every switch, not merely element count or draft ID.
    const scene = { type: "excalidraw", version: 2, source: "pi-webapp", files: {},
      appState: { viewBackgroundColor: "#ffffff", scrollX: 31, scrollY: 47, zoom: { value: 0.75 } },
      elements: Array.from({ length: 100 }, (_, i) => ({ id: "element-" + i, type: i === 99 ? "text" : "rectangle", x: i % 10 * 120, y: Math.floor(i / 10) * 80, width: 100, height: 60,
        groupIds: ["group-" + Math.floor(i / 10)], strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "hachure", strokeWidth: 1, roughness: 1, opacity: 100,
        seed: i + 1, version: 1, versionNonce: i + 1, isDeleted: false, angle: 0, boundElements: [], updated: 1, link: null, locked: false,
        ...(i === 99 ? { text: "中文基准", originalText: "中文基准", fontSize: 20, fontFamily: 5, textAlign: "left", verticalAlign: "top", containerId: null, autoResize: true, lineHeight: 1.25 } : {}) })) };
    const draft = await action("import", { title: "100 elements / 中文", scene });
    const before = await action("get", { id: draft.id }); const expectedHash = hash(before);
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== address.origin) external.push(request.url()); });
    await page.addInitScript(() => { localStorage.setItem("pi-web-locale", "en"); });
    await page.goto(bridge.url);
    const boot = await page.evaluate(() => { const value = crypto.randomUUID(); (window as any).__stressBoot = value; return value; });
    const waitReady = async (generation: number) => {
      await expect(page.locator('iframe[title="Excalidraw controller"]')).toHaveCount(1);
      await expect.poll(() => {
        const coordinators = [...(integration as any).views.values()];
        return coordinators.length === 1 && coordinators[0].views.size === 1 && [...coordinators[0].views.values()].every((view: any) => view.identity.generation === generation && !view.busy);
      }, { timeout: 12_000 }).toBe(true);
      await expect(page.locator(`iframe[title="Excalidraw controller"][src*="generation=${generation}"]`)).toHaveCount(1);
    };
    await waitReady((await broker.active())!.generation);
    const cdp = await page.context().newCDPSession(page); await cdp.send("Performance.enable");
    const samples: number[] = [], heaps: number[] = [], hostRss: number[] = [];
    const cpuBefore = process.cpuUsage(); const elapsedStart = performance.now();
    for (let i = 0; i < 70; i++) {
      const supervisor = (integration.manager as any).supervisors.get(id);
      // Private test inspection is deliberate; production does not expose process handles.
      const oldPid: number | undefined = supervisor.pid;
      const start = performance.now();
      const response = await fetch(address.origin + "/api/hosted-plugins/manage", { method: "POST", headers, body: JSON.stringify({ pluginId: id, operation: "enable" }) });
      expect(response.status).toBe(200);
      const catalog = await response.json(); const generation = catalog.plugins[0].generation;
      await waitReady(generation);
      const ms = performance.now() - start;
      expect(hash(await action("get", { id: draft.id }))).toBe(expectedHash);
      expect(sessions.session).toBe(retained);
      expect(await page.evaluate(() => (window as any).__stressBoot)).toBe(boot);
      expect(integration.manager.tools[0]!.descriptors).toHaveLength(6);
      expect(new Set(integration.manager.tools[0]!.descriptors.map(tool => tool.name)).size).toBe(6);
      if (oldPid) { observedPids.add(oldPid); expect(() => process.kill(oldPid, 0)).toThrow(); }
      if (i >= 20) {
        samples.push(ms);
        await cdp.send("HeapProfiler.collectGarbage");
        const metrics = await cdp.send("Performance.getMetrics");
        heaps.push(metrics.metrics.find(value => value.name === "JSHeapUsedSize")!.value);
        hostRss.push(process.memoryUsage().rss);
      }
    }
    const active = (await broker.active())!;
    expect(await readdir(join(broker.root, "states"))).toHaveLength(2);
    expect((await integration.manager.installer.inventory()).versions[id]).toHaveLength(1); // Same immutable staged code, 70 new generations.
    const first = percentile(heaps.slice(0, 10), 0.5), last = percentile(heaps.slice(-10), 0.5);
    // Explicit bounded-growth smoke budget, NOT a promise that GC returns RSS to baseline.
    expect(last - first).toBeLessThan(first * 0.25 + 8 * 1024 * 1024);
    expect(errors).toEqual([]); expect(external).toEqual([]);
    const report = { environment: { node: process.version, browserName, browserVersion: page.context().browser()!.version(), os: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem() },
      scope: "Complete host App + real HTTP + retained SDK + real worker + controller realm; staged same-version replacement, no active editor/provider/network download",
      archiveSha256: createHash("sha256").update(bytes).digest("hex"), archiveBytes: bytes.length, archiveInstallMs, sceneElements: 100, checkpointHash: expectedHash,
      warmups: 20, measuredCycles: samples.length, ms: { p50: percentile(samples, 0.5), p95: percentile(samples, 0.95), max: Math.max(...samples), samples },
      designTargetP95Ms: 2000, designTargetMet: percentile(samples, 0.95) <= 2000,
      parentCpuMicroseconds: process.cpuUsage(cpuBefore), wallMs: performance.now() - elapsedStart,
      parentRssBytes: { min: Math.min(...hostRss), max: Math.max(...hostRss), last: hostRss.at(-1) },
      browserPostGcHeapBytes: { firstMedian: first, lastMedian: last, growth: last - first, samples: heaps },
      oldWorkerPidsConfirmedExited: observedPids.size, generation: active.generation, activeFrames: 1, activeTools: 6, retainedStateSnapshots: 2, externalRequests: external.length, pageErrors: errors.length,
      limitations: ["Same-version local reactivation, not different-version installation", "No editor gesture, frame ports/timers direct census, child CPU/RSS or Electron/other-platform certification", "Browser heap budget is smoke-only; not an exhaustive leak proof"] };
    expect(observedPids.size).toBe(70);
    await info.attach("reference-measurement.json", { body: JSON.stringify(report, null, 2), contentType: "application/json" });
    console.log(JSON.stringify(report, null, 2));
    expect(report.designTargetMet, "Reference design P95 <=2s; retain measurements on failure, do not weaken target").toBe(true);
  } finally {
    await integration.shutdown(); await page.close(); await bridge?.close(); await sessions.dispose();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    if (previousRoots === undefined) delete process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS; else process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS = previousRoots;
    await rm(root, { recursive: true, force: true });
  }
});
