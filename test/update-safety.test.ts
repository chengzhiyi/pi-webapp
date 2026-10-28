import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { startBridge } from "../src/host/server/transport/bridge.ts";
import { terminalHost } from "./helpers/terminal-host.ts";

const webRoot = fileURLToPath(new URL("../web/dist/", import.meta.url));

test("updates protect background chats and terminals; downloads keep chat available and only handoff locks mutations", async () => {
  const { host } = terminalHost();
  let busy = true; let fail = false; let prepared = 0; let restarted = 0;
  let release!: () => void;
  let downloading!: () => void;
  const downloadStarted = new Promise<void>(resolve => { downloading = resolve; });
  const download = new Promise<void>(resolve => { release = resolve; });
  host.busyGitWorkspaces = () => busy ? ["/background-chat"] : [];
  host.selfUpdate = {
    async check() { return { current: "0.1.0", latest: "0.2.0", available: true, canRestart: true }; },
    async runningVersion() { return "0.1.0"; },
    async prepare() { prepared++; if (fail) throw new Error("network unavailable"); downloading(); await download; return { version: "0.2.0", launcher: "/prepared" }; },
    async requestRestart() { restarted++; },
  };
  const bridge = await startBridge(host, webRoot);
  const url = new URL(bridge.url);
  const headers = { Authorization: `Bearer ${url.hash.slice(1)}`, "Content-Type": "application/json", Origin: url.origin };
  const post = (path: string, extra = {}) => fetch(`${url.origin}${path}`, { method: "POST", headers, body: JSON.stringify({ sessionId: "terminal-a", ...extra }) });
  try {
    assert.equal((await post("/api/update")).status, 409);
    assert.equal(prepared, 0);
    busy = false;
    const id = randomUUID();
    assert.equal((await post("/api/terminal/create", { id, cols: 80, rows: 24 })).status, 201);
    const terminalBusy = await post("/api/update");
    assert.equal(terminalBusy.status, 409);
    assert.match((await terminalBusy.json()).error, /终端/);
    assert.equal(prepared, 0);
    await post("/api/terminal/close", { id });
    fail = true;
    assert.equal((await post("/api/update")).status, 400);
    // A failed download must release the mutation lock.
    assert.equal((await post("/api/model", { provider: "example", id: "model" })).status, 202);
    fail = false;
    const update = post("/api/update");
    await downloadStarted;
    assert.equal((await post("/api/update")).status, 409);
    assert.equal((await post("/api/message", { text: "chat remains available during download" })).status, 202);
    assert.equal((await post("/api/model", { provider: "example", id: "model" })).status, 202);
    assert.equal((await post("/api/terminal/create", { id, cols: 80, rows: 24 })).status, 201);
    await post("/api/terminal/close", { id });
    release();
    assert.equal((await update).status, 202);
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.equal(restarted, 1);
    assert.equal((await post("/api/message", { text: "still restarting" })).status, 409);
  } finally { release(); await bridge.close(); }
});

test("channel preferences require authentication, same origin, a current session and a known channel", async () => {
  const { host } = terminalHost();
  let channel = "stable"; let saved = 0;
  host.selfUpdate = {
    async check() { return { current: "0.1.0", latest: "0.2.0", available: true, canRestart: true }; },
    async runningVersion() { return "0.1.0"; },
    async setChannel(value) { channel = value; saved++; return { channel: value }; },
    async prepare() { throw new Error("must not install"); }, async requestRestart() {},
  };
  const bridge = await startBridge(host, webRoot);
  const url = new URL(bridge.url);
  const headers = { Authorization: `Bearer ${url.hash.slice(1)}`, "Content-Type": "application/json", Origin: url.origin };
  const post = (body: unknown, extra = {}) => fetch(`${url.origin}/api/update/channel`, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  try {
    assert.equal((await post({ sessionId: "terminal-a", channel: "alpha" }, { Authorization: "Bearer invalid" })).status, 401);
    assert.equal((await post({ sessionId: "terminal-a", channel: "alpha" }, { Origin: "https://example.com" })).status, 403);
    assert.equal((await post({ sessionId: "stale", channel: "alpha" })).status, 409);
    assert.equal((await post({ sessionId: "terminal-a", channel: "beta" })).status, 400);
    assert.equal(saved, 0);
    assert.equal((await post({ sessionId: "terminal-a", channel: "alpha" })).status, 200);
    assert.equal(channel, "alpha"); assert.equal(saved, 1);
  } finally { await bridge.close(); }
});

test("download cancellation is available through authenticated same-session HTTP while current chat remains usable", async () => {
  const { host } = terminalHost(); let started!: () => void, rejectDownload!: (error: Error) => void, cancelled = 0;
  const began = new Promise<void>(resolve => { started = resolve; });
  const download = new Promise<void>((_resolve, reject) => { rejectDownload = reject; });
  host.selfUpdate = {
    async check() { return { current: "0.1.0", latest: "0.2.0", available: true, canRestart: true }; },
    async runningVersion() { return "0.1.0"; },
    async prepare() { started(); await download; throw new Error("unexpected completion"); },
    async requestRestart() { assert.fail("cancelled download cannot restart"); },
    async cancel() { cancelled++; rejectDownload(new Error("download cancelled")); },
  };
  const bridge = await startBridge(host, webRoot), url = new URL(bridge.url);
  const headers = { Authorization: `Bearer ${url.hash.slice(1)}`, "Content-Type": "application/json", Origin: url.origin };
  const post = (path: string, body: Record<string, unknown> = { sessionId: "terminal-a" }, override = {}) => fetch(url.origin + path, { method: "POST", headers: { ...headers, ...override }, body: JSON.stringify(body) });
  try {
    const update = post("/api/update"); await began;
    assert.equal((await post("/api/update/cancel", undefined, { Authorization: "Bearer invalid" })).status, 401);
    assert.equal((await post("/api/update/cancel", { sessionId: "stale" })).status, 409);
    assert.equal((await post("/api/update/cancel", undefined, { Origin: "https://other.invalid" })).status, 403);
    assert.equal((await post("/api/update/cancel")).status, 200); assert.equal(cancelled, 1);
    assert.equal((await update).status, 400);
    assert.equal((await post("/api/model", { sessionId: "terminal-a", provider: "example", id: "model" })).status, 202);
  } finally { rejectDownload(new Error("cleanup")); await bridge.close(); }
});
