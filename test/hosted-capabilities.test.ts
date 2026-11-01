import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { HostedInvocation } from "@chengzhiyi/pi-web-protocol";
import { CapabilityBroker } from "../src/host/server/plugins/hosted/capabilities/broker.ts";
import { parseDeclarations } from "../src/host/server/plugins/hosted/capabilities/declarations.ts";
import { pluginFetch, privateAddress } from "../src/host/server/plugins/hosted/capabilities/network.ts";
import { PluginScheduler } from "../src/host/server/plugins/hosted/capabilities/scheduler.ts";
import { FileSecretStore, MemorySecretStore } from "../src/host/server/plugins/hosted/capabilities/secrets.ts";
import type { SessionsHost } from "../src/host/server/plugins/hosted/capabilities/sessions.ts";

const manifest = { capabilities: ["secrets", "network", "scheduler", "sessions"], secrets: [{ name: "github-token" }], network: { hosts: ["api.github.com"] }, schedules: [{ id: "poll", intervalSec: 60, action: "sync" }] };
const invocation = { requestId: "r1", generation: 1, scope: { cwd: "/work", workspaceId: "w", sessionId: "s" }, kind: "action", action: "x", input: {} } as HostedInvocation;
const publicDns = async () => ["140.82.112.5"];

test("declarations require capability string and valid concrete entries", () => {
  const d = parseDeclarations(manifest);
  assert.deepEqual([d.secrets, d.networkHosts, d.sessions, d.schedules.length], [["github-token"], ["api.github.com"], true, 1]);
  assert.deepEqual(parseDeclarations({ ...manifest, capabilities: [] }), { secrets: [], networkHosts: [], schedules: [], sessions: false });
  for (const bad of [{ network: { hosts: ["*.github.com"] } }, { network: { hosts: ["127.0.0.1"] } }, { schedules: [{ id: "a", intervalSec: 5, action: "x" }] }, { secrets: [{ name: "Bad Name" }] }])
    assert.throws(() => parseDeclarations({ ...manifest, ...bad }));
});

test("network: injects secret host-side, redacts it, blocks undeclared hosts, http, and private addresses", async () => {
  const secrets = new MemorySecretStore(); await secrets.set("p", "github-token", "ghp_SECRET");
  let seen: { url: string; auth?: string } | undefined;
  const fake = (async (url: URL, init: RequestInit) => { seen = { url: String(url), auth: (init.headers as Record<string, string>).Authorization }; return new Response("echo ghp_SECRET", { status: 200, headers: { "content-type": "text/plain", "set-cookie": "x=1" } }); }) as unknown as typeof fetch;
  const deps = { secrets, fetch: fake, resolve: publicDns };
  const ok = await pluginFetch("p", ["api.github.com"], ["github-token"], { url: "https://api.github.com/issues", secret: "github-token" }, deps);
  assert.equal(seen!.auth, "Bearer ghp_SECRET");
  assert.equal(ok.body, "echo [redacted]");
  assert.deepEqual(Object.keys(ok.headers), ["content-type"]);
  const denied = (url: string, extra = {}, resolve = publicDns) => pluginFetch("p", ["api.github.com"], ["github-token"], { url, ...extra }, { ...deps, resolve });
  await assert.rejects(denied("http://api.github.com/"), { code: "network_denied" });
  await assert.rejects(denied("https://evil.example/"), { code: "network_denied" });
  await assert.rejects(denied("https://api.github.com:8443/"), { code: "network_denied" });
  await assert.rejects(denied("https://api.github.com/", { secret: "other" }), { code: "network_denied" });
  await assert.rejects(denied("https://api.github.com/", { headers: { Authorization: "x" } }), { code: "invalid_input" });
  await assert.rejects(denied("https://api.github.com/", {}, async () => ["10.0.0.5"]), { code: "network_denied" });
  assert.ok(privateAddress("::1") && privateAddress("169.254.169.254") && !privateAddress("140.82.112.5"));
  await assert.rejects(pluginFetch("q", ["api.github.com"], ["github-token"], { url: "https://api.github.com/", secret: "github-token" }, deps), { code: "secret_missing" });
});

test("network: oversize responses fail", async () => {
  const fake = (async () => new Response("x".repeat(100))) as unknown as typeof fetch;
  await assert.rejects(pluginFetch("p", ["api.github.com"], [], { url: "https://api.github.com/" }, { secrets: new MemorySecretStore(), fetch: fake, resolve: publicDns, maxResponseBytes: 10 }), { code: "response_too_large" });
});

test("file secret store is 0600 and per plugin", async () => {
  const root = await mkdtemp(join(tmpdir(), "secrets-"));
  try {
    const store = new FileSecretStore(root);
    await store.set("a", "k", "v"); await store.set("b", "k", "w");
    assert.equal(await store.get("a", "k"), "v"); assert.equal(await store.get("b", "k"), "w");
    await store.delete("a", "k"); assert.equal(await store.has("a", "k"), false);
    const { createHash } = await import("node:crypto");
    assert.equal((await stat(join(root, "secrets", `${createHash("sha256").update("b").digest("hex")}.json`))).mode & 0o777, 0o600);
  } finally { await rm(root, { recursive: true, force: true }); }
});

function fakeSessions(): SessionsHost & { created: unknown[] } {
  const owners = new Map<string, string>(), created: unknown[] = [];
  return { created, create: async o => { created.push(o); const sessionId = `s${owners.size + 1}`; owners.set(sessionId, o.pluginId); return { sessionId }; },
    ownerOf: id => owners.get(id) ?? null, activeCount: p => [...owners.values()].filter(x => x === p).length,
    send: async () => {}, abort: async () => {}, release: async id => { owners.delete(id); }, events: async (_id, after) => ({ events: [], next: after }) };
}
test("sessions: plan-only, cwd from invocation, ownership and quota enforced, capability gated", async () => {
  const host = fakeSessions();
  const broker = new CapabilityBroker({ secrets: new MemorySecretStore(), sessions: host, maxActiveSessions: 2 });
  const call = (id: string, method: string, input: unknown, m: unknown = manifest) => broker.call(id, m, invocation, method, input);
  await assert.rejects(call("p", "sessions.create", { title: "t", prompt: "p", mode: "execute" }), { code: "invalid_input" });
  const a = await call("p", "sessions.create", { title: "t", prompt: "p", mode: "plan", cwd: "/etc" }) as { sessionId: string };
  assert.equal((host.created[0] as { cwd: string }).cwd, "/work");
  await call("p", "sessions.create", { title: "t", prompt: "p", mode: "plan" });
  await assert.rejects(call("p", "sessions.create", { title: "t", prompt: "p", mode: "plan" }), { code: "quota_exceeded" });
  await assert.rejects(call("other", "sessions.send", { sessionId: a.sessionId, message: "hi" }), { code: "session_denied" });
  assert.deepEqual(await call("p", "sessions.send", { sessionId: a.sessionId, message: "hi", mode: "execute" }), { ok: true });
  await assert.rejects(call("p", "sessions.send", { sessionId: a.sessionId, message: "hi", mode: "root" }), { code: "invalid_input" });
  await call("p", "sessions.release", { sessionId: a.sessionId });
  assert.equal(host.activeCount("p"), 1);
  await assert.rejects(call("p", "sessions.create", { title: "t", prompt: "p", mode: "plan" }, { capabilities: [] }), { code: "capability_denied" });
  await assert.rejects(call("p", "network.fetch", { url: "https://api.github.com/" }, { capabilities: [] }), { code: "capability_denied" });
});

test("scheduler: runs on interval, skips overlapping ticks, isolates errors, stops", async () => {
  const handlers: Array<() => void> = []; let release!: () => void, calls = 0; const errors: unknown[] = [];
  const s = new PluginScheduler({ invoke: () => { calls++; return new Promise<void>(r => { release = r; }); }, onError: (_p, _s, e) => errors.push(e),
    setInterval: fn => { handlers.push(fn); return handlers.length; }, clearInterval: () => { handlers.length = 0; } });
  const decl = parseDeclarations(manifest).schedules[0]!;
  s.start("p", [decl]);
  const first = s.tick("p", decl);
  assert.equal(await s.tick("p", decl), false); assert.equal(calls, 1);
  release(); assert.equal(await first, true);
  const failing = new PluginScheduler({ invoke: async () => { throw new Error("boom"); }, onError: (_p, _s, e) => errors.push(e), setInterval: () => 1, clearInterval: () => {} });
  assert.equal(await failing.tick("p", decl), false); assert.equal(errors.length, 1);
  s.stop("p"); assert.equal(handlers.length, 0);
});
