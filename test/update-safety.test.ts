import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { startBridge } from "../src/host/server/transport/bridge.ts";
import { terminalHost } from "./helpers/terminal-host.ts";

const webRoot = fileURLToPath(new URL("../web/dist/", import.meta.url));

test("updates protect background chats and terminals, and lock mutations during installation", async () => {
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
    for (const path of ["/api/update", "/api/message", "/api/terminal/create", "/api/workspace/select"]) {
      assert.equal((await post(path, { id, text: "must not start", cols: 80, rows: 24 })).status, 409);
    }
    release();
    assert.equal((await update).status, 202);
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.equal(restarted, 1);
    assert.equal((await post("/api/message", { text: "still restarting" })).status, 409);
  } finally { release(); await bridge.close(); }
});
