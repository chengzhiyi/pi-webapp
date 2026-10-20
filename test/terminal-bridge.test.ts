import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { startBridge } from "../src/host/server/transport/bridge.ts";
import { terminalHost } from "./helpers/terminal-host.ts";


test("all terminal routes enforce auth, origin, active session and terminal ownership", async () => {
  const { host, switchSession } = terminalHost();
  const bridge = await startBridge(host, fileURLToPath(new URL("../web/dist/", import.meta.url)));
  let closed = false;
  const url = new URL(bridge.url);
  const headers = { Authorization: `Bearer ${url.hash.slice(1)}`, "Content-Type": "application/json", Origin: url.origin };
  const id = randomUUID();
  const request = (action: string, body: object = {}, selected = headers) => fetch(`${url.origin}/api/terminal/${action}`, { method: "POST", headers: selected, body: JSON.stringify({ sessionId: "terminal-a", id, cols: 80, rows: 24, data: "echo test\r", ...body }) });
  try {
    const page = await fetch(url.origin);
    const html = await page.text();
    const nonce = /name="pi-style-nonce" content="([^"]+)"/.exec(html)?.[1];
    assert.ok(nonce);
    assert.ok(page.headers.get("content-security-policy")?.includes(`style-src 'self' 'nonce-${nonce}'`));
    assert.ok(page.headers.get("content-security-policy")?.includes("style-src-attr 'unsafe-inline'"));
    assert.match(page.headers.get("content-security-policy")!, /script-src 'self';/);
    const secondPage = await (await fetch(url.origin)).text();
    assert.notEqual(/name="pi-style-nonce" content="([^"]+)"/.exec(secondPage)?.[1], nonce);
    for (const action of ["create", "attach", "input", "resize", "close"]) {
      assert.equal((await request(action, {}, { ...headers, Authorization: "" })).status, 401);
      assert.equal((await request(action, {}, { ...headers, Origin: "https://evil.example" })).status, 403);
      assert.equal((await request(action, { id: "invalid" })).status, 400);
      if (action !== "close") assert.equal((await request(action, { sessionId: "stale" })).status, 409);
    }
    assert.equal((await request("create", { cols: 0 })).status, 400);
    assert.equal((await request("create", { rows: 301 })).status, 400);
    const cwd = host.snapshot().cwd;
    switchSession("terminal-a", "/no/such/pi-terminal-workspace");
    assert.equal((await request("create")).status, 400);
    switchSession("terminal-a", cwd);
    assert.equal((await request("create")).status, 201);
    assert.equal((await request("create")).status, 201);
    assert.equal((await request("input", { data: "a".repeat(16_385) })).status, 400);
    assert.equal((await request("resize", { rows: 0 })).status, 400);
    assert.equal((await request("resize", { cols: 90, rows: 30 })).status, 200);
    const attached = await request("attach");
    assert.equal(attached.status, 200);
    assert.match(attached.headers.get("content-type")!, /ndjson/);
    const reader = attached.body!.getReader();
    const initial = await reader.read();
    assert.match(new TextDecoder().decode(initial.value), /"type":"snapshot"/);
    switchSession("terminal-b");
    for (const action of ["create", "attach", "input", "resize"]) assert.equal((await request(action)).status, 409);
    assert.equal((await request("input", { sessionId: "terminal-b" })).status, 400);
    assert.equal((await request("close", { sessionId: "terminal-b" })).status, 400);
    assert.equal((await request("close")).status, 200); // Owned inactive-session cleanup is allowed.
    assert.equal((await request("close")).status, 200);
    await reader.cancel();
    assert.equal((await request("create", { sessionId: "terminal-b", id: randomUUID() })).status, 201);
    const live = await request("attach", { sessionId: "terminal-b", id }); // Old id cannot attach.
    assert.equal(live.status, 400);
    const nextId = randomUUID();
    assert.equal((await request("create", { sessionId: "terminal-b", id: nextId })).status, 201);
    const shutdown = await request("attach", { sessionId: "terminal-b", id: nextId });
    await bridge.close(); closed = true;
    await shutdown.text(); // Service shutdown ends the stream and reaps its shell.
  } finally { if (!closed) await bridge.close(); }
});
