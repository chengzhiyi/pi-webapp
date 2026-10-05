import { test, expect, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { startBridge, type Bridge, type BridgeHost } from "../../extension/bridge.ts";
import { DEFAULT_SENTRY_DSN, NodeTelemetry } from "../../extension/telemetry.ts";
import type { Event } from "@sentry/core";
import type { SessionView } from "../../extension/view.ts";

const snapshot: SessionView = { schemaVersion: 1, sessionId: "private-session", cwd: "/private/workspace", name: "Test session", model: "example/model", thinkingLevel: "off", thinkingLevels: ["off"], idle: true, contextUsage: null, messages: [], pluginEntries: [] };
const root = fileURLToPath(new URL("../../web/dist/", import.meta.url));
const host: BridgeHost = {
  snapshot: () => snapshot, models: () => [{ provider: "example", id: "model", name: "Example model" }], commands: () => [], send() {}, abort() {}, async newSession() {},
  async setModel() {}, async setThinkingLevel() {},
  config: () => ({ projectTrusted: true, global: { packages: [], extensions: [], skills: [] }, project: { packages: [], extensions: [], skills: [] }, installed: { packages: [], extensions: [], skills: [] } }),
  async updateConfig() { return this.config(); }, async workspaces() { return { items: [], activeId: null, sessions: [] }; },
  async addWorkspace() {}, async selectWorkspace() {}, async newSessionInWorkspace() {}, async removeWorkspace() {}, async selectSession() {},
};

async function fixture(page: Page, enabled: boolean | "default" = true, overrides: Partial<BridgeHost> = {}, environment = "production") {
  const browserEvents: Event[] = [];
  const nodeEvents: Event[] = [];
  const destination = enabled === "default" ? new URL(DEFAULT_SENTRY_DSN).origin : "https://telemetry.example";
  await page.route(`${destination}/**`, async (route) => {
    const lines = route.request().postData()?.split("\n") ?? [];
    if (JSON.parse(lines[1] ?? "{}").type === "event") browserEvents.push(JSON.parse(lines[2]!));
    await route.fulfill({ status: 200, body: "{}", headers: { "Access-Control-Allow-Origin": "*" } });
  });
  const telemetryOptions: ConstructorParameters<typeof NodeTelemetry>[0] = { env: enabled === "default" ? {} : enabled ? { PI_WEB_SENTRY_DSN: "https://public@telemetry.example/1", PI_WEB_SENTRY_ENVIRONMENT: environment } : { PI_WEB_SENTRY_ENABLED: "false" }, monitor: false,
    transport: () => ({ send: async (envelope) => { for (const [h, e] of envelope[1]) if (h.type === "event") nodeEvents.push(e as Event); return { statusCode: 200 }; }, flush: async () => true }),
  };
  const telemetry = new NodeTelemetry(telemetryOptions);
  const bridge = await startBridge({ ...host, ...overrides }, root, telemetry);
  const sdkReady = enabled ? page.waitForResponse((r) => r.url().includes("telemetry-client-")).catch(() => undefined) : undefined;
  return { bridge, browserEvents, nodeEvents, sdkReady, newTelemetry: () => new NodeTelemetry(telemetryOptions) };
}

async function open(page: Page, bridge: Bridge) {
  await page.goto(bridge.url);
  await expect(page.getByRole("textbox")).toBeEnabled();
}

for (const failure of ["read", "end"] as const) {
  test(`stream ${failure} failures retain request correlation and disconnected state, then reconnect`, async ({ page }) => {
    const f = await fixture(page);
    const requestId = "550e8400-e29b-41d4-a716-446655440000";
    await page.addInitScript(({ snapshot, requestId, failure }) => {
      const originalFetch = window.fetch;
      let injected = false;
      window.fetch = async (...args) => {
        if (!injected && String(args[0]) === "/api/events") {
          injected = true;
          const body = new ReadableStream({ start(controller) {
            controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ type: "snapshot", session: snapshot })}\n`));
            Object.assign(window, { failTestStream: () => failure === "read" ? controller.error(new TypeError("Synthetic stream read failed")) : controller.close() });
          } });
          return new Response(body, { headers: { "Content-Type": "application/x-ndjson", "X-Request-ID": requestId } });
        }
        return originalFetch(...args);
      };
    }, { snapshot, requestId, failure });
    try {
      await open(page, f.bridge); await f.sdkReady;
      const reconnected = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/events");
      await page.evaluate(() => (window as unknown as { failTestStream(): void }).failTestStream());
      await expect.poll(() => f.browserEvents.length).toBe(1);
      expect(f.browserEvents[0]?.contexts?.diagnostic).toMatchObject({ stage: `stream_${failure}`, requestId, route: "/api/events", connection: "disconnected" });
      await reconnected;
      await expect(page.getByRole("textbox")).toBeEnabled();
      expect(f.browserEvents).toHaveLength(1);
      expect(f.nodeEvents).toEqual([]);
    } finally { await f.bridge.close(); }
  });
}

test("unavailable workspaces disable session actions, recover and can be removed", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let removed = false;
  const unavailable = { id: "missing", path: "/missing/worktree", title: "Deleted worktree", available: false };
  const healthy = { id: "healthy", path: snapshot.cwd, title: "Healthy project" }; // Older hosts omit availability.
  const value = { items: [healthy, unavailable], activeId: "healthy", sessions: [] };
  const f = await fixture(page, true, {
    async workspaces() { return value; },
    async removeWorkspace(id) { removed = id === unavailable.id; f.bridge.publish({ type: "workspaces", value: { ...value, items: [healthy] } }); },
  });
  try {
    await open(page, f.bridge); await f.sdkReady;
    const missing = page.getByRole("treeitem", { name: /Deleted worktree/ });
    await expect(missing).toContainText(/不可用|Unavailable/);
    await expect(page.getByRole("button", { name: /(?:在 Deleted worktree 新建会话|Create a session in Deleted worktree)/ })).toBeDisabled();
    await expect(page.getByRole("button", { name: /(?:在 Healthy project 新建会话|Create a session in Healthy project)/ })).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath("unavailable-workspace.png") });
    f.bridge.publish({ type: "workspaces", value: { ...value, items: [healthy, { ...unavailable, available: true }] } });
    await expect(missing).not.toContainText(/不可用|Unavailable/);
    await expect(page.getByRole("button", { name: /(?:在 Deleted worktree 新建会话|Create a session in Deleted worktree)/ })).toBeEnabled();
    f.bridge.publish({ type: "workspaces", value });
    await expect(missing).toContainText(/不可用|Unavailable/);
    await missing.hover();
    await page.getByRole("button", { name: /^(?:移除 Deleted worktree|Remove Deleted worktree)$/ }).click();
    await expect(missing).toHaveCount(0);
    expect(removed).toBe(true);
    expect(errors).toEqual([]);
    expect(f.browserEvents).toEqual([]);
    expect(f.nodeEvents).toEqual([]);
  } finally { await f.bridge.close(); }
});

async function openUpdate(page: Page, bridge: Bridge) {
  await page.route("**/api/update", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(route.request().method() === "POST"
    ? { version: "0.1.10" }
    : { current: "0.1.9", latest: "0.1.10", available: true, canRestart: true }) }));
  await open(page, bridge);
  await page.getByRole("button", { name: /^(Pi 设置|Pi Settings)$/ }).click();
  await expect(page.getByRole("button", { name: /^(升级并重启|Update and restart)$/ })).toBeVisible();
}

test("update polling tolerates restart disconnects and reloads the target version without reporting errors", async ({ page }) => {
  const f = await fixture(page);
  let attempts = 0;
  await page.route("**/api/update/version", (route) => ++attempts <= 2 ? route.abort("connectionrefused") : route.fulfill({ contentType: "application/json", body: JSON.stringify({ current: "0.1.10" }) }));
  try {
    await openUpdate(page, f.bridge); await f.sdkReady;
    const reloaded = page.waitForEvent("domcontentloaded");
    await page.getByRole("button", { name: /^(升级并重启|Update and restart)$/ }).click();
    await reloaded;
    await expect(page.getByRole("textbox")).toBeEnabled();
    expect(attempts).toBe(3);
    expect(f.browserEvents).toEqual([]);
  } finally { await f.bridge.close(); }
});

for (const failure of ["disconnected", "stale-version", "pending"] as const) {
  test(`update restart timeout reports once even when the version request is ${failure}`, async ({ page }) => {
    const f = await fixture(page);
    let attempts = 0;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/api/update/version", async (route) => {
      attempts++;
      if (failure === "disconnected") { await route.abort("connectionrefused"); return; }
      if (failure === "pending") await pending;
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ current: "0.1.9" }) }).catch(() => {});
    });
    try {
      await openUpdate(page, f.bridge); await f.sdkReady;
      await page.clock.install();
      await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
      await page.getByRole("button", { name: /^(升级并重启|Update and restart)$/ }).click();
      await expect(page.getByText(/^(正在重启并等待新版连接…|Restarting and waiting for the new version…)$/)).toBeVisible();
      await page.clock.fastForward(1200);
      await expect.poll(() => attempts).toBe(1);
      await page.clock.fastForward(60_000);
      await expect(page.getByRole("alert")).toContainText(/新版启动超时|The new version did not start in time/);
      await expect.poll(() => f.browserEvents.length).toBe(1);
      expect(f.browserEvents[0]?.contexts?.diagnostic).toMatchObject({ stage: "update_restart", code: "update_restart_timeout", route: "/api/update/version", timeoutMs: 60_000 });
      if (failure === "disconnected") expect(f.browserEvents[0]?.breadcrumbs?.some((item) => item.category === "request_failed" && item.data?.route === "/api/update/version")).toBe(true);
      const stoppedAt = attempts;
      await page.clock.fastForward(60_000);
      expect(attempts).toBe(stoppedAt);
      expect(f.browserEvents).toHaveLength(1);
    } finally { release(); await f.bridge.close(); }
  });
}

test("closing update settings cancels polling without a later timeout report", async ({ page }) => {
  const f = await fixture(page);
  let attempts = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/update/version", async (route) => {
    attempts++;
    await pending;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ current: "0.1.10" }) }).catch(() => {});
  });
  try {
    await openUpdate(page, f.bridge); await f.sdkReady;
    let reloads = 0;
    page.on("domcontentloaded", () => { reloads++; });
    await page.clock.install();
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
    await page.getByRole("button", { name: /^(升级并重启|Update and restart)$/ }).click();
    await expect(page.getByText(/^(正在重启并等待新版连接…|Restarting and waiting for the new version…)$/)).toBeVisible();
    await page.clock.fastForward(1200);
    await expect.poll(() => attempts).toBe(1);
    const cancelled = page.waitForEvent("requestfailed", (request) => new URL(request.url()).pathname === "/api/update/version");
    await page.getByRole("button", { name: /^(关闭 Pi 设置|Close Pi settings)$/ }).click();
    await cancelled;
    release();
    await page.clock.fastForward(120_000);
    expect(attempts).toBe(1);
    expect(reloads).toBe(0);
    expect(f.browserEvents).toEqual([]);
  } finally { release(); await f.bridge.close(); }
});

test("update polling still reports HTTP and response parsing failures", async ({ page }) => {
  const f = await fixture(page);
  let attempts = 0;
  await page.route("**/api/update/version", (route) => {
    attempts++;
    return route.fulfill({ contentType: "application/json", status: attempts === 1 ? 500 : 200, body: attempts === 1
      ? JSON.stringify({ error: "Synthetic version endpoint failure" })
      : attempts === 2 ? "invalid-json" : JSON.stringify({ current: "0.1.10" }) });
  });
  try {
    await openUpdate(page, f.bridge); await f.sdkReady;
    const reloaded = page.waitForEvent("domcontentloaded");
    await page.getByRole("button", { name: /^(升级并重启|Update and restart)$/ }).click();
    await reloaded;
    await expect.poll(() => f.browserEvents.length).toBe(2);
    expect(f.browserEvents.map((event) => event.contexts?.diagnostic?.stage).sort()).toEqual(["http", "response_parse"]);
  } finally { await f.bridge.close(); }
});

test("ordinary update-check network failures are still reported", async ({ page }) => {
  const f = await fixture(page);
  try {
    await openUpdate(page, f.bridge); await f.sdkReady;
    await page.route("**/api/update", (route) => route.abort("connectionrefused"));
    await page.getByRole("button", { name: /^(检查更新|Check for updates)$/ }).click();
    await expect.poll(() => f.browserEvents.length).toBe(1);
    expect(f.browserEvents[0]?.contexts?.diagnostic).toMatchObject({ route: "/api/update", stage: "network" });
  } finally { await f.bridge.close(); }
});

test("when disabled the page works, SDK stays unloaded, and console stays clean", async ({ page }) => {
  const errors: string[] = [];
  const sdk: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => { if (request.url().includes("telemetry-client-")) sdk.push(request.url()); });
  const f = await fixture(page, false);
  try { await open(page, f.bridge); await page.getByRole("textbox").fill("synthetic prompt"); await page.getByRole("button", { name: /^(发送消息|Send message)$/ }).click(); }
  finally { await f.bridge.close(); }
  expect(errors).toEqual([]);
  expect(sdk).toEqual([]);
  expect(f.browserEvents).toEqual([]);
});

test("the built-in DSN enables browser reporting without environment configuration", async ({ page }) => {
  const f = await fixture(page, "default");
  try {
    await open(page, f.bridge); await f.sdkReady;
    await page.evaluate(() => { setTimeout(() => { throw new Error("Synthetic default DSN test"); }, 0); });
    await expect.poll(() => f.browserEvents.length).toBe(1);
    expect(f.browserEvents[0]?.contexts?.diagnostic?.stage).toBe("global");
  } finally { await f.bridge.close(); }
});

test("release probes require a verification environment and explicit URL flag", async ({ page }) => {
  const production = await fixture(page);
  try {
    const url = new URL(production.bridge.url); url.searchParams.set("sentry_release_probe", "1");
    await page.goto(url.href); await production.sdkReady;
    await expect(page.getByRole("textbox")).toBeEnabled();
    expect(production.browserEvents).toEqual([]);
  } finally { await production.bridge.close(); }
  const verification = await fixture(page, true, {}, "sentry-verification");
  try {
    const url = new URL(verification.bridge.url); url.searchParams.set("sentry_release_probe", "1");
    await page.goto(url.href); await verification.sdkReady;
    await expect.poll(() => verification.browserEvents.length).toBe(1);
    expect(verification.browserEvents[0]?.environment).toBe("sentry-verification");
    expect(verification.browserEvents[0]?.contexts?.diagnostic?.code).toBe("sentry_release_probe");
    expect(verification.browserEvents[0]?.debug_meta?.images?.length).toBeGreaterThan(0);
    expect(verification.browserEvents[0]?.exception?.values?.[0]?.stacktrace?.frames?.some(frame => frame.filename === "app:///assets/app.js")).toBe(true);
  } finally { await verification.bridge.close(); }
});

test("backend failures keep correlation and are not reported twice by the browser", async ({ page }) => {
  const f = await fixture(page, true, { send() { throw new Error("Synthetic backend failure token=server-secret"); } });
  try {
    await open(page, f.bridge);
    await f.sdkReady;
    await page.getByRole("textbox").fill("private prompt contents");
    await page.getByRole("button", { name: /^(发送消息|Send message)$/ }).click();
    await expect.poll(() => f.nodeEvents.length).toBe(1);
    expect(f.nodeEvents[0]?.contexts?.diagnostic?.operationId).toMatch(/^[a-f0-9-]{36}$/);
    expect(JSON.stringify(f.nodeEvents)).not.toContain("private prompt contents");
    expect(JSON.stringify(f.nodeEvents)).not.toContain("server-secret");
    expect(f.browserEvents).toEqual([]);
  } finally { await f.bridge.close(); }
});

test("startup-buffered global errors and unhandled rejections reach the mock Sentry without secrets", async ({ page }) => {
  await page.route("**/api/telemetry/config", async (route) => { await new Promise((resolve) => setTimeout(resolve, 300)); await route.continue(); });
  const f = await fixture(page);
  try {
    await open(page, f.bridge);
    await page.evaluate(() => {
      setTimeout(() => { throw new Error("Synthetic global failure token=browser-secret"); }, 0);
      void Promise.reject(new Error("Synthetic rejection password=another-secret"));
    });
    await expect.poll(() => f.browserEvents.length).toBe(2);
    expect(JSON.stringify(f.browserEvents)).not.toMatch(/browser-secret|another-secret|private-session|private\/workspace/);
    expect(f.browserEvents.map((e) => e.contexts?.diagnostic?.stage).sort()).toEqual(["global", "unhandled_rejection"]);
  } finally { await f.bridge.close(); }
});

test("Sentry configuration timeout never delays the usable page", async ({ page }) => {
  await page.route("**/api/telemetry/config", async (route) => { await new Promise((resolve) => setTimeout(resolve, 1500)); await route.continue().catch(() => {}); });
  const f = await fixture(page);
  try {
    const started = Date.now();
    await page.goto(f.bridge.url, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("textbox")).toBeEnabled();
    expect(Date.now() - started).toBeLessThan(1000);
  } finally { await f.bridge.close(); }
});

test("invalid protocol events are captured with build debug IDs and the app can reconnect", async ({ page }) => {
  const f = await fixture(page);
  try {
    const connected = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/events" && r.status() === 200);
    await test.step("open", () => open(page, f.bridge));
    await connected;
    await test.step("SDK ready", async () => { await f.sdkReady; });
    const reconnected = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/events" && r.status() === 200);
    f.bridge.publish({ type: "snapshot", session: { ...snapshot, schemaVersion: 99 } } as unknown as Parameters<Bridge["publish"]>[0]);
    await test.step("capture", async () => { await expect.poll(() => f.browserEvents.length).toBe(1); });
    expect(f.browserEvents[0]?.debug_meta?.images?.some((image) => image.debug_id)).toBe(true);
    for (const image of f.browserEvents[0]?.debug_meta?.images ?? []) {
      const file = image.code_file?.replace("app:///", "");
      if (!file?.startsWith("assets/")) continue;
      const map = JSON.parse(await readFile(fileURLToPath(new URL(`../../.sentry-artifacts/${f.browserEvents[0]!.dist}/browser/${file}.map`, import.meta.url)), "utf8"));
      expect(map.debug_id).toBe(image.debug_id);
    }
    expect(f.browserEvents[0]?.exception?.values?.[0]?.stacktrace?.frames?.some((frame) => frame.filename?.startsWith("app:///assets/"))).toBe(true);
    await test.step("reconnect", async () => { await reconnected; await expect(page.getByRole("textbox")).toBeEnabled(); });
  } finally { await test.step("close", () => f.bridge.close()); }
});

test("React render failures show a refresh fallback and attach a component stack", async ({ page }) => {
  const f = await fixture(page);
  try {
    await open(page, f.bridge); await f.sdkReady;
    f.bridge.publish({ type: "snapshot", session: { ...snapshot, messages: [{ id: "broken", role: "assistant", timestamp: new Date().toISOString(), blocks: null }] } } as unknown as Parameters<Bridge["publish"]>[0]);
    await expect(page.getByRole("button", { name: /^(刷新页面|Refresh page)$/ })).toBeVisible();
    await expect.poll(() => f.browserEvents.some((e) => e.contexts?.diagnostic?.stage === "react")).toBe(true);
    expect(f.browserEvents.find((e) => e.contexts?.diagnostic?.stage === "react")?.contexts?.diagnostic?.componentStack).toBeTruthy();
  } finally { await f.bridge.close(); }
});

test("invalid NDJSON is captured once without uploading the response body", async ({ page }) => {
  await page.route("**/api/events", (route) => route.fulfill({ contentType: "application/x-ndjson", body: `${JSON.stringify({ type: "snapshot", session: snapshot })}\n{"secret": "private-response-body"\n` }));
  const f = await fixture(page);
  try {
    await page.goto(f.bridge.url); await f.sdkReady;
    await expect.poll(() => f.browserEvents.length).toBe(1);
    expect(f.browserEvents[0]?.contexts?.diagnostic?.stage).toBe("ndjson_parse");
    expect(JSON.stringify(f.browserEvents)).not.toContain("private-response-body");
  } finally { await f.bridge.close(); }
});

test("controlled launcher restart reconnects at the same address without an error report", async ({ page }) => {
  const f = await fixture(page);
  let replacement: Bridge | undefined;
  const previousPort = process.env.PI_WEBAPP_RESTART_PORT;
  const previousToken = process.env.PI_WEBAPP_RESTART_TOKEN;
  try {
    await open(page, f.bridge); await f.sdkReady;
    const connected = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/events" && response.status() === 200);
    const url = new URL(f.bridge.url);
    await f.bridge.close({ reconnect: true });
    process.env.PI_WEBAPP_RESTART_PORT = url.port;
    process.env.PI_WEBAPP_RESTART_TOKEN = url.hash.slice(1);
    replacement = await startBridge(host, root, f.newTelemetry());
    expect(replacement.url).toBe(f.bridge.url);
    await connected;
    await expect(page.getByRole("textbox")).toBeEditable();
    expect(f.browserEvents).toEqual([]);
    expect(f.nodeEvents).toEqual([]);
  } finally {
    if (previousPort === undefined) delete process.env.PI_WEBAPP_RESTART_PORT; else process.env.PI_WEBAPP_RESTART_PORT = previousPort;
    if (previousToken === undefined) delete process.env.PI_WEBAPP_RESTART_TOKEN; else process.env.PI_WEBAPP_RESTART_TOKEN = previousToken;
    await replacement?.close();
  }
});

test("plugin asset updates still reload the page instead of becoming protocol errors", async ({ page }) => {
  const f = await fixture(page);
  try {
    await open(page, f.bridge); await f.sdkReady;
    const reloaded = page.waitForEvent("domcontentloaded");
    f.bridge.publish({ type: "plugins_changed" });
    await reloaded;
    await expect(page.getByRole("textbox")).toBeEditable();
    expect(f.browserEvents).toEqual([]);
    await page.screenshot({ path: "artifacts/sentry-integration.png", fullPage: true });
  } finally { await f.bridge.close(); }
});

test("streaming frame budget with and without telemetry", async ({ browser }) => {
  test.skip(process.env.PI_WEB_BENCHMARK !== "true", "Run with PI_WEB_BENCHMARK=true for the performance comparison");
  test.setTimeout(60_000);
  const samples: Array<{ enabled: boolean; frameP95Ms: number; longTasks: number }> = [];
  const history = Array.from({ length: 100 }, (_, i) => ({ id: `history-${i}`, role: i % 2 ? "assistant" as const : "user" as const, timestamp: new Date().toISOString(), blocks: [{ kind: "text" as const, text: `Synthetic history ${i}` }] }));
  for (const enabled of [false, true, true, false]) {
    const page = await browser.newPage();
    const f = await fixture(page, enabled, { snapshot: () => ({ ...snapshot, messages: history }) });
    try {
      await open(page, f.bridge); if (enabled) await f.sdkReady;
      await page.evaluate(() => {
        const target = window as unknown as { piBenchmark: { frames: number[]; longTasks: number; active: boolean } };
        target.piBenchmark = { frames: [], longTasks: 0, active: true };
        new PerformanceObserver((entries) => { target.piBenchmark.longTasks += entries.getEntries().length; }).observe({ entryTypes: ["longtask"] });
        let last = performance.now();
        const frame = (now: number) => { target.piBenchmark.frames.push(now - last); last = now; if (target.piBenchmark.active) requestAnimationFrame(frame); };
        requestAnimationFrame(frame);
      });
      for (let i = 0; i < 40; i++) {
        f.bridge.publish({ type: "stream", message: { id: "stream", role: "assistant", timestamp: new Date().toISOString(), blocks: [{ kind: "text", text: `Streaming update ${i}: ${"Synthetic text. ".repeat(100)}` }] } });
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
      const measured = await page.evaluate(() => {
        const target = window as unknown as { piBenchmark: { frames: number[]; longTasks: number; active: boolean } };
        target.piBenchmark.active = false;
        const frames = target.piBenchmark.frames.slice(5).sort((a, b) => a - b);
        return { frameP95Ms: frames[Math.floor(frames.length * 0.95)]!, longTasks: target.piBenchmark.longTasks };
      });
      samples.push({ enabled, ...measured });
      expect(f.browserEvents).toEqual([]);
    } finally { await page.close(); await f.bridge.close(); }
  }
  const average = (enabled: boolean) => samples.filter((s) => s.enabled === enabled).reduce((sum, s) => sum + s.frameP95Ms, 0) / 2;
  const deltaPercent = (average(true) / average(false) - 1) * 100;
  console.log(JSON.stringify({ samples, frameP95DeltaPercent: Number(deltaPercent.toFixed(2)), targetPercent: 2 }));
  // A wider guard detects obvious regressions; the 2% target requires interpreting timing noise.
  expect(average(true)).toBeLessThan(average(false) * 1.1);
});
