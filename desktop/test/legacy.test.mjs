import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DesktopBackend, DesktopConnectionError } from "../backend.mjs";

const token = "b".repeat(32);
const snapshot = { schemaVersion: 1, sessionId: "existing-chat", cwd: "/workspace", idle: false, messages: [], pluginEntries: [] };
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "pi-legacy-test-"));
  const requests = [];
  let streamClosed = false;
  const server = createServer((req, res) => {
    requests.push({ path: req.url, method: req.method, authorization: req.headers.authorization });
    if (req.headers.authorization !== `Bearer ${token}` || options.unauthorized) { res.writeHead(401); res.end(); return; }
    const respond = (value, type = "application/json") => { res.setHeader("Content-Type", type); res.end(JSON.stringify(value)); };
    if (req.url === "/api/update/version") {
      if (options.redirect) { res.writeHead(302, { Location: `/unexpected?token=${token}` }); res.end(); return; }
      respond({ current: options.version ?? "0.1.19" }); return;
    }
    if (req.url === "/api/session") {
      if (options.missingSession) { res.writeHead(404); res.end(); return; }
      respond(options.session ?? snapshot, options.sessionType); return;
    }
    if (req.url === "/api/events") {
      res.writeHead(200, { "Content-Type": options.eventType ?? "application/x-ndjson" });
      res.on("close", () => { streamClosed = true; });
      res.write(options.eventBody ?? JSON.stringify({ type: "snapshot", session: snapshot }) + "\n");
      return; // Deliberately stay open: successful detection must cancel this probe.
    }
    res.writeHead(404); res.end();
  });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const state = { pid: 123, piPid: 124, nonce: "existing-owner", url: `http://127.0.0.1:${server.address().port}/#${token}` };
  const backend = new DesktopBackend({ agentDir: directory, version: "0.1.19", isAlive: () => true,
    spawnProcess: () => { throw new Error("must not start a duplicate backend"); }, timeoutMs: 1000 });
  await mkdir(join(directory, "pi-web"));
  const save = value => writeFile(backend.statePath, JSON.stringify(value));
  await save(state);
  return { backend, state, requests, save, streamClosed: () => streamClosed };
}

async function unchanged(backend, state) {
  assert.equal(backend.owned, false);
  await backend.stop();
  assert.deepEqual(JSON.parse(await readFile(backend.statePath, "utf8")), state);
  await assert.rejects(readFile(backend.stopPath), { code: "ENOENT" });
}

test("released legacy Web backend is reused with read-only authenticated session/event probes", async t => {
  const { backend, state, requests, streamClosed } = await fixture(t);
  assert.deepEqual(await backend.connect(), state);
  await unchanged(backend, state);
  assert.deepEqual(requests.map(({ path }) => path), ["/api/update/version", "/api/session", "/api/events"]);
  for (const request of requests) {
    assert.equal(request.method, "GET");
    assert.equal(request.authorization, `Bearer ${token}`);
    assert.ok(!request.path.includes(token));
  }
  for (let i = 0; i < 30 && !streamClosed(); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(streamClosed(), true, "NDJSON compatibility probe must not leak a subscriber");
});

test("missing bridge marker with an otherwise matching version also takes legacy probes", async t => {
  const { backend, state, save, requests } = await fixture(t);
  const markedVersion = { ...state, version: "0.1.19", runtimeKind: "npm" };
  await save(markedVersion);
  assert.deepEqual(await backend.connect(), markedVersion);
  assert.equal(requests.length, 3);
  await unchanged(backend, markedVersion);
});

test("legacy fallback rejects unsupported versions, explicit protocol markers and incomplete identity", async t => {
  for (const overrides of [{ version: "0.1.18" }, { bridgeVersion: 99 }, { bridgeVersion: null }, { bridgeVersion: 1 }, { nonce: "" }, { pid: 0 }]) {
    const { backend, state, save, requests } = await fixture(t);
    const bad = { ...state, ...overrides };
    await save(bad);
    await assert.rejects(backend.connect(), error => error instanceof DesktopConnectionError && Boolean(error.browserUrl));
    assert.equal(requests.length, 1, "known incompatible metadata must not enter legacy probes");
    await unchanged(backend, bad);
  }
  const { backend, state } = await fixture(t, { version: "0.1.20" });
  backend.version = "0.1.20";
  await assert.rejects(backend.connect(), { code: "legacy-unverified" });
  await unchanged(backend, state);
});

test("unrecognized session/event schema, transport and frames are rejected without replacing the service", async t => {
  for (const options of [
    { session: { ...snapshot, schemaVersion: 99 } }, { session: { current: "0.1.19" } },
    { sessionType: "text/html" }, { eventType: "text/event-stream" }, { missingSession: true },
    { eventBody: JSON.stringify({ type: "snapshot", session: { ...snapshot, schemaVersion: 2 } }) + "\n" },
    { eventBody: JSON.stringify({ type: "other" }) + "\n" }, { eventBody: "not-json\n" },
    { eventBody: "x".repeat(16 * 1024 * 1024 + 1) },
  ]) {
    const { backend, state } = await fixture(t, options);
    await assert.rejects(backend.connect(), error => error.code === "legacy-incompatible" && error.browserUrl === state.url);
    await unchanged(backend, state);
  }
});

test("invalid addresses never receive a token; authentication and network failures are distinct and secret-safe", async t => {
  const { backend, state, save, requests } = await fixture(t);
  await save({ ...state, url: `http://example.com/#${token}` });
  await assert.rejects(backend.connect(), { code: "invalid-address" });
  assert.equal(requests.length, 0);
  const unauthorized = await fixture(t, { unauthorized: true });
  await assert.rejects(unauthorized.backend.connect(), error => error.code === "authentication-failed" && !error.browserUrl);
  await unchanged(unauthorized.backend, unauthorized.state);
  await save(state);
  backend.fetchRequest = async () => { throw new Error(`redirect/timeout with sensitive URL ${state.url}`); };
  await assert.rejects(backend.connect(), error => error.code === "health-failed" && !error.message.includes(token) && !error.browserUrl);
  await unchanged(backend, state);
});

test("an interrupted event stream is closed and reported as a failed capability check", async t => {
  const { backend, state } = await fixture(t);
  const actualFetch = backend.fetchRequest;
  backend.fetchRequest = async (url, options) => {
    if (!url.endsWith("/api/events")) return actualFetch(url, options);
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("partial")); controller.close(); } }),
      { headers: { "Content-Type": "application/x-ndjson" } });
  };
  await assert.rejects(backend.connect(), { code: "legacy-incompatible" });
  await unchanged(backend, state);
});

test("redirects are never followed and incomplete event streams remain time-bounded", async t => {
  const redirected = await fixture(t, { redirect: true });
  await assert.rejects(redirected.backend.connect(), error => error.code === "health-failed" && !error.message.includes(token));
  assert.equal(redirected.requests.length, 1);
  await unchanged(redirected.backend, redirected.state);
  const stalled = await fixture(t, { eventBody: "{\"type\":\"snapshot\"" });
  const actualFetch = stalled.backend.fetchRequest;
  stalled.backend.fetchRequest = (url, options) => actualFetch(url, { ...options,
    ...(url.endsWith("/api/events") ? { signal: AbortSignal.timeout(100) } : {}) });
  await assert.rejects(stalled.backend.connect(), { code: "legacy-incompatible" });
  await unchanged(stalled.backend, stalled.state);
});

test("service replacement during a legacy handshake is rechecked instead of attaching stale state", async t => {
  const { backend, state, save } = await fixture(t);
  const actualFetch = backend.fetchRequest;
  let replaced = false;
  const replacement = { ...state, pid: 125, nonce: "replacement-owner", version: "0.1.19", bridgeVersion: 1 };
  backend.fetchRequest = async (url, options) => {
    const result = await actualFetch(url, options);
    if (url.endsWith("/api/events")) { await save(replacement); replaced = true; }
    return result;
  };
  assert.deepEqual(await backend.connect(), replacement);
  assert.equal(replaced, true);
  await unchanged(backend, replacement);
});
