import assert from "node:assert/strict";
import test from "node:test";
import { ErrorBudget, BreadcrumbBuffer, sanitizeError, sanitizeEvent, safeFields } from "../shared/telemetry.ts";
import { DEFAULT_SENTRY_DSN, NodeTelemetry, readTelemetryConfig } from "../extension/telemetry.ts";
import { getClient, getCurrentScope, getGlobalScope, type Event } from "@sentry/core";
import { ProviderLoginController } from "../extension/provider-login.ts";

test("DSN configuration defaults on, supports per-side overrides, and never inherits host Sentry settings", () => {
  const dsn = "https://public@example.com/12";
  const defaults = readTelemetryConfig({});
  assert.equal(defaults.browser.enabled, true);
  assert.equal(defaults.node.enabled, true);
  assert.equal(defaults.browser.dsn, DEFAULT_SENTRY_DSN);
  assert.equal(defaults.node.dsn, DEFAULT_SENTRY_DSN);
  assert.equal(readTelemetryConfig({ PI_WEB_SENTRY_DSN: dsn }).browser.enabled, true);
  assert.equal(readTelemetryConfig({ PI_WEB_SENTRY_DSN: dsn, PI_WEB_SENTRY_ENABLED: "false" }).node.enabled, false);
  assert.equal(readTelemetryConfig({ SENTRY_DSN: dsn }).node.dsn, DEFAULT_SENTRY_DSN);
  assert.equal(readTelemetryConfig({ PI_WEB_SENTRY_ENABLED: "false" }).browser.enabled, false);
  const blank = readTelemetryConfig({ PI_WEB_SENTRY_DSN: "" });
  assert.equal(blank.browser.enabled, false);
  assert.equal(blank.node.enabled, false);
  const sideDisabled = readTelemetryConfig({ PI_WEB_SENTRY_NODE_DSN: "" });
  assert.equal(sideDisabled.node.enabled, false);
  assert.equal(sideDisabled.browser.dsn, DEFAULT_SENTRY_DSN);
  const split = readTelemetryConfig({ PI_WEB_SENTRY_DSN: dsn, PI_WEB_SENTRY_NODE_DSN: "https://other@node.example.com/34" });
  assert.equal(split.browser.dsn, dsn);
  assert.equal(split.node.dsn, "https://other@node.example.com/34");
  const defaultOverride = readTelemetryConfig({ PI_WEB_SENTRY_BROWSER_DSN: dsn });
  assert.equal(defaultOverride.browser.dsn, dsn);
  assert.equal(defaultOverride.node.dsn, DEFAULT_SENTRY_DSN);
  for (const invalid of ["garbage", "https://public:secret@example.com/12", "https://public@example.com/12?token=secret"]) {
    assert.equal(readTelemetryConfig({ PI_WEB_SENTRY_DSN: invalid }, () => {}).node.enabled, false);
  }
});

test("outgoing events exclude bodies, credentials, source lines and personal paths, retaining stack locations", () => {
  const original = new Error('failed token=super-secret-token email=jane@example.com file /Users/jane/private/project.txt "prompt contents"');
  original.stack = original.message + "\n    at send (file:///Users/jane/project/extension/bridge.ts:20:4)";
  const clean = sanitizeError(original);
  const event = sanitizeEvent({
    exception: { values: [{ type: clean.name, value: clean.message, stacktrace: { frames: [{ filename: "/Users/jane/project/dist/extension.js", lineno: 20, colno: 4, context_line: "apiKey=private-secret" }] } }] },
    request: { url: "http://localhost/#access-token", headers: { Authorization: "Bearer secret" }, data: "prompt contents" },
    user: { email: "jane@example.com" }, extra: { source: "private-secret" },
    contexts: { diagnostic: { stage: "http", requestId: "abc", text: "prompt contents" } },
  });
  const wire = JSON.stringify(event);
  for (const secret of ["super-secret-token", "jane", "prompt contents", "private-secret", "access-token", "Authorization"]) assert.ok(!wire.includes(secret), secret);
  assert.match(wire, /extension\.js/);
  assert.equal(event.exception?.values?.[0]?.stacktrace?.frames?.[0]?.lineno, 20);
  assert.deepEqual(safeFields({ stage: "http", text: "private", attachments: ["private"] }), { stage: "http" });
  assert.equal(safeFields({ route: "/api/message?token=private-secret" }).route, "/api/message");
  assert.equal(safeFields({ route: "/api/private/workspace" }).route, "[route]");
});

test("rate limiting bounds distinct errors and carries repeat counts into the next window", () => {
  const budget = new ErrorBudget();
  assert.deepEqual(budget.take("same", 0), { repeats: 0 });
  assert.equal(budget.take("same", 1), undefined);
  for (let i = 0; i < 19; i++) assert.ok(budget.take(`other-${i}`, 2));
  assert.equal(budget.take("overflow", 3), undefined);
  assert.deepEqual(budget.take("same", 60_001), { repeats: 1 });
});

test("breadcrumbs remain bounded and discard fields outside the allowlist", () => {
  const buffer = new BreadcrumbBuffer();
  for (let i = 0; i < 500; i++) buffer.add("request", { stage: "upload", text: "private-content", durationMs: i });
  const items = buffer.snapshot();
  assert.equal(items.length, 100);
  assert.ok(Buffer.byteLength(JSON.stringify(items)) <= 64 * 1024);
  assert.ok(!JSON.stringify(items).includes("private-content"));
  for (let i = 0; i < 500; i++) buffer.add("unicode", { componentStack: "组件".repeat(1000) });
  assert.ok(Buffer.byteLength(JSON.stringify(buffer.snapshot())) <= 64 * 1024);
});

test("isolated Node capture emits sanitized correlated events and preserves the host scope and handlers", async () => {
  const events: Event[] = [];
  const types: string[] = [];
  const scope = getCurrentScope();
  const client = getClient();
  const handlers = process.listeners("uncaughtException");
  const beforeExit = process.listenerCount("beforeExit");
  const telemetry = new NodeTelemetry({
    env: { PI_WEB_SENTRY_DSN: "https://public@example.com/12" }, monitor: false,
    transport: () => ({ send: async (envelope) => {
      for (const [header, payload] of envelope[1]) { types.push(header.type); if (header.type === "event") events.push(payload as Event); }
      return { statusCode: 200 };
    }, flush: async () => true }),
  });
  const hostScope = getGlobalScope();
  const attachments = hostScope.getScopeData().attachments;
  hostScope.addAttachment({ filename: "host-secret.txt", data: "private-host-attachment" });
  try {
    const error = new Error("operation failed token=private-secret", { cause: new Error("underlying failure password=cause-secret") });
    assert.ok(telemetry.capture(error, { requestId: "request-a", operationId: "operation-a", stage: "http", text: "private-input" }));
    assert.equal(telemetry.capture(error), undefined);
    telemetry.capture(new Error("会话已切换"));
  } finally { await telemetry.close(); hostScope.clearAttachments(); for (const attachment of attachments) hostScope.addAttachment(attachment); }
  assert.equal(events.length, 1);
  assert.equal(events[0]?.contexts?.diagnostic?.operationId, "operation-a");
  assert.ok(!JSON.stringify(events).includes("private-secret"));
  assert.ok(!JSON.stringify(events).includes("private-input"));
  assert.ok(!JSON.stringify(events).includes("cause-secret"));
  assert.equal(events[0]?.exception?.values?.length, 2);
  assert.deepEqual(types, ["event"]);
  assert.equal(getClient(), client);
  assert.equal(getCurrentScope(), scope);
  assert.deepEqual(process.listeners("uncaughtException"), handlers);
  assert.equal(process.listenerCount("beforeExit"), beforeExit);
});

test("login failures retain correlation without capturing provider prompts or credential-bearing messages", async () => {
  const errors: Array<{ cause: unknown; context: unknown }> = [];
  const login = new ProviderLoginController((cause, context) => { errors.push({ cause, context }); return "a".repeat(32); });
  const started = login.start("example", "api_key", async () => { throw new Error("provider echoed a private unquoted API key"); }, undefined, { requestId: "request-login" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(login.get(started.id)?.errorId, "a".repeat(32));
  assert.equal(errors.length, 1);
  assert.equal((errors[0]?.context as { requestId?: string }).requestId, "request-login");
  assert.ok(!JSON.stringify(errors).includes("private unquoted API key"));
  const cancelled = login.start("example", "oauth", async (_id, _method, interaction) => { await interaction.prompt({ type: "text", message: "private prompt" }); });
  login.cancel(cancelled.id);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(errors.length, 1);
  assert.equal((errors[0]?.context as { requestId?: string }).requestId, "request-login");
  login.close();
});
