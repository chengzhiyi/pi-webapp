import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventBus, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { requestWebInteraction, WebInteractionHost, type WebInteraction } from "@chengzhiyi/pi-web-protocol";
import { TerminalRegistry } from "../src/plugins/builtin/terminal/server/terminals.ts";
import { parseSend, terminalAgentAction, visibleText, type TerminalAgentResult } from "../src/plugins/builtin/terminal/server/agent.ts";
import { terminalTools } from "../src/plugins/builtin/terminal/server/tools.ts";
import { TERMINAL_INPUT_APPROVAL } from "../src/plugins/builtin/terminal/contract/terminal.ts";
import { BUILTIN_IDS } from "../src/contracts/plugins.ts";
import { startBridge } from "../src/host/server/transport/bridge.ts";
import { NodeTelemetry } from "../src/platform/telemetry/telemetry.ts";
import { terminalHost } from "./helpers/terminal-host.ts";
import { WorkspaceSessions } from "../src/host/server/sessions/workspace-sessions.ts";

const shell = { shell: "/bin/bash", shellArgs: ["--noprofile", "--norc", "-i"] };
const context = (cwd: string, sessionId: string) => ({ cwd, sessionManager: { getSessionId: () => sessionId } }) as unknown as Parameters<ToolDefinition["execute"]>[4];
const text = (value: { content: Array<{ type: string; text?: string }> }) => value.content.map(item => item.text ?? "").join("");
async function until(check: () => Promise<boolean> | boolean) {
  const deadline = Date.now() + 5000;
  while (!await check()) { if (Date.now() > deadline) throw new Error("Timed out waiting for shell"); await new Promise(resolve => setTimeout(resolve, 20)); }
}

test("agent terminal actions stay inside the calling session and bound their input and output", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-terminal-agent-"));
  const registry = new TerminalRegistry(shell);
  t.after(async () => { await registry.close(); await rm(cwd, { recursive: true, force: true }); });
  await assert.rejects(terminalAgentAction(registry, "session-a", "prepare", { text: "ls" }), /no open terminal/);
  const first = randomUUID();
  registry.create(first, "session-a", cwd, 80, 24);
  registry.create(randomUUID(), "session-b", cwd, 80, 24);
  // With one terminal in the session the agent may omit the id; another session's terminal never resolves.
  assert.deepEqual(await terminalAgentAction(registry, "session-a", "prepare", { text: "ls" }), { terminalId: first });
  await assert.rejects(terminalAgentAction(registry, "session-c", "read", { terminalId: first }), /不属于此会话/);
  await assert.rejects(terminalAgentAction(registry, "session-c", "send", { terminalId: first, text: "touch leaked" }), /不属于此会话/);
  const second = randomUUID();
  registry.create(second, "session-a", cwd, 80, 24);
  await assert.rejects(terminalAgentAction(registry, "session-a", "read", {}), new RegExp(`2 open terminals.*${first}`));

  assert.throws(() => parseSend({ text: "printf x\x1b[2J" }), /control characters/);
  assert.throws(() => parseSend({ text: "x".repeat(4097) }), /longer than 4096/);
  assert.throws(() => parseSend({ text: "", enter: false }), /Nothing to send/);
  assert.throws(() => parseSend({ text: "ls", terminalId: "../other" }), /contentId/);
  assert.throws(() => parseSend({ text: "ls", waitMs: 60_000 }), /waitMs/);
  assert.deepEqual(parseSend({ text: "a\r\nb" }), { terminalId: undefined, text: "a\nb", enter: true, waitMs: 3000, lines: 40 });
  await assert.rejects(terminalAgentAction(registry, "session-a", "send", { text: "ls" }), /terminalId is required/);

  const sent = await terminalAgentAction(registry, "session-a", "send", { terminalId: first, text: "for i in 1 2 3 4 5; do printf 'LINE_%s\\n' $i; done", waitMs: 5000 }) as TerminalAgentResult;
  assert.equal(sent.terminalId, first);
  assert.match(sent.output, /LINE_5/);
  // A busy shell only echoes typed text until it reads it; the reply waits for the real output.
  registry.get(first, "session-a").write("sleep 1.5\r");
  await new Promise(resolve => setTimeout(resolve, 300));
  const busy = await terminalAgentAction(registry, "session-a", "send", { terminalId: first, text: "printf 'AFTER_%s\\n' BUSY", waitMs: 5000 }) as TerminalAgentResult;
  assert.match(busy.output, /AFTER_BUSY/);
  const read = await terminalAgentAction(registry, "session-a", "read", { terminalId: first, lines: 2 }) as TerminalAgentResult;
  assert.equal(read.output.split("\n").length, 2);
  assert.doesNotMatch(read.output, /LINE_5/);
  assert.equal(visibleText("\u001b]2;title\u0007p\bprintf  'x'\u001b[?2004l\r\n"), "printf'x'");
  await terminalAgentAction(registry, "session-a", "send", { terminalId: second, text: "exit 3", waitMs: 5000 });
  await until(async () => (await terminalAgentAction(registry, "session-a", "read", { terminalId: second }) as TerminalAgentResult).exitCode === 3);
  await assert.rejects(terminalAgentAction(registry, "session-a", "prepare", { terminalId: second, text: "ls" }), /exited/);
  // An exited shell no longer counts, so the id may be omitted again.
  assert.deepEqual(await terminalAgentAction(registry, "session-a", "prepare", { text: "ls" }), { terminalId: first });
  // Text without Enter is typed but not run.
  await terminalAgentAction(registry, "session-a", "send", { terminalId: first, text: "touch typed-only", enter: false, waitMs: 300 });
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(await readFile(join(cwd, "typed-only"), "utf8").catch(() => "missing"), "missing");
  assert.match((await terminalAgentAction(registry, "session-a", "read", { terminalId: first, lines: 1 }) as TerminalAgentResult).output, /touch typed-only$/);
});

test("terminal_send types only the exact text the user allowed, through the session's interaction host", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-terminal-tools-"));
  const registry = new TerminalRegistry(shell);
  const bus = createEventBus();
  const changes: number[] = [];
  const interactions = new WebInteractionHost(bus, request => request.sessionId === "session-a", () => changes.push(changes.length));
  t.after(async () => { interactions.dispose(); await registry.close(); await rm(cwd, { recursive: true, force: true }); });
  const id = randomUUID();
  registry.create(id, "session-a", cwd, 80, 24);
  const asked: WebInteraction[] = [];
  const [send, read] = terminalTools({
    run: (_cwd, sessionId, action, input, signal) => terminalAgentAction(registry, sessionId, action, input, signal),
    ask: (request, signal) => { asked.push(request); return requestWebInteraction(bus, request, signal); },
  });
  assert.deepEqual([send!.name, read!.name], ["terminal_send", "terminal_read"]);
  const ctx = context(cwd, "session-a");

  // Denied: nothing is written.
  const denied = send!.execute("call-1", { text: "printf DENIED > denied.txt" }, undefined, undefined, ctx);
  await until(() => interactions.pending("session-a").length === 1);
  const [pending] = interactions.pending("session-a");
  assert.equal(pending!.pluginId, BUILTIN_IDS.terminal);
  assert.equal(pending!.kind, TERMINAL_INPUT_APPROVAL);
  assert.deepEqual(pending!.data, { terminalId: id, text: "printf DENIED > denied.txt", enter: true });
  interactions.resolve("session-a", BUILTIN_IDS.terminal, pending!.requestId, { allow: false });
  await assert.rejects(denied, /declined/);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(await readFile(join(cwd, "denied.txt"), "utf8").catch(() => "missing"), "missing");
  // Anything but an explicit allow is a refusal.
  const vague = send!.execute("call-2", { text: "printf VAGUE > vague.txt" }, undefined, undefined, ctx);
  await until(() => interactions.pending("session-a").length === 1);
  interactions.resolve("session-a", BUILTIN_IDS.terminal, interactions.pending("session-a")[0]!.requestId, true);
  await assert.rejects(vague, /declined/);

  // Allowed: the command runs in the user's shell and its output comes back.
  const allowed = send!.execute("call-3", { terminalId: id, text: "printf 'AGENT_%s\\n' OK" }, undefined, undefined, ctx);
  await until(() => interactions.pending("session-a").length === 1);
  interactions.resolve("session-a", BUILTIN_IDS.terminal, interactions.pending("session-a")[0]!.requestId, { allow: true });
  const result = await allowed;
  assert.match(text(result), /AGENT_OK/);
  assert.match(text(result), /^Sent after the user approved/);
  assert.match(text(await read!.execute("call-4", { terminalId: id, lines: 5 }, undefined, undefined, ctx)), /AGENT_OK/);

  // Cancelling the turn withdraws the request without typing anything.
  const controller = new AbortController();
  const aborted = send!.execute("call-5", { text: "printf ABORTED > aborted.txt" }, controller.signal, undefined, ctx);
  await until(() => interactions.pending("session-a").length === 1);
  controller.abort();
  await assert.rejects(aborted);
  assert.equal(interactions.pending("session-a").length, 0);
  assert.equal(await readFile(join(cwd, "aborted.txt"), "utf8").catch(() => "missing"), "missing");

  // Invalid input never reaches the user.
  const before = asked.length;
  await assert.rejects(send!.execute("call-6", { text: "\x03" }, undefined, undefined, ctx), /control characters/);
  await assert.rejects(send!.execute("call-7", { text: "ls" }, undefined, undefined, context(cwd, "session-b")), /no open terminal/);
  assert.equal(asked.length, before);
});

test("the bridge runs terminal agent actions only for an enabled plugin and never exposes send over HTTP", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-terminal-bridge-agent-"));
  const { host } = terminalHost(cwd);
  const bridge = await startBridge(host, new URL("../web/dist", import.meta.url).pathname, new NodeTelemetry({ env: { PI_WEB_SENTRY_ENABLED: "false" }, monitor: false }), { pluginSettingsFile: join(cwd, "plugins.json") });
  t.after(async () => { await bridge.close(); await rm(cwd, { recursive: true, force: true }); });
  const url = new URL(bridge.url);
  const headers = { Authorization: `Bearer ${url.hash.slice(1)}`, "Content-Type": "application/json", Origin: url.origin };
  const post = (path: string, body: object) => fetch(url.origin + path, { method: "POST", headers, body: JSON.stringify({ sessionId: "terminal-a", ...body }) });
  const id = randomUUID();
  assert.equal((await post("/api/terminal/create", { id, cols: 80, rows: 24 })).status, 201);
  assert.deepEqual(await bridge.runPluginTool(BUILTIN_IDS.terminal, cwd, "terminal-a", "prepare", { text: "ls" }), { terminalId: id });
  await assert.rejects(bridge.runPluginTool(BUILTIN_IDS.terminal, cwd, "terminal-b", "read", { terminalId: id }));
  for (const action of ["send", "prepare", "read"]) assert.equal((await post("/api/plugin-action", { pluginId: BUILTIN_IDS.terminal, action, input: { terminalId: id, text: "touch via-http" } })).status, 400);
  const view = await fetch(url.origin + "/api/plugin-management", { headers }).then(response => response.json()) as { revision: string };
  assert.equal((await post("/api/plugin-management", { id: BUILTIN_IDS.terminal, enabled: false, expected: view.revision })).status, 200);
  await assert.rejects(bridge.runPluginTool(BUILTIN_IDS.terminal, cwd, "terminal-a", "prepare", { text: "ls" }), /已停用/);
});

test("retained SDK sessions expose the terminal tools and host builtin approvals in their snapshot", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-terminal-sdk-"));
  const savedAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const tools = terminalTools({ run: async () => { throw new Error("unused"); }, ask: async () => { throw new Error("unused"); } });
  const host = new WorkspaceSessions(() => {}, () => undefined, () => false, undefined, undefined, undefined, tools);
  t.after(async () => {
    await host.dispose();
    if (savedAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedAgent;
    await rm(root, { recursive: true, force: true });
  });
  await host.open(root, "new");
  assert.ok(host.session!.getActiveToolNames().includes("terminal_send"));
  assert.ok(host.session!.getActiveToolNames().includes("terminal_read"));
  const sessionId = host.snapshot().sessionId;
  const request = { requestId: randomUUID(), sessionId, pluginId: BUILTIN_IDS.terminal, kind: TERMINAL_INPUT_APPROVAL, data: { terminalId: randomUUID(), text: "ls", enter: true } };
  const answer = host.requestInteraction(request);
  assert.deepEqual(host.snapshot().interactions, [request]);
  host.resolveInteraction(sessionId, BUILTIN_IDS.terminal, request.requestId, { allow: true });
  assert.deepEqual(await answer, { allow: true });
  assert.deepEqual(host.snapshot().interactions, []);
  // Unknown plugins still need a catalog entry, and another session cannot be addressed.
  await assert.rejects(host.requestInteraction({ ...request, requestId: randomUUID(), pluginId: "@example/unknown" }));
  await assert.rejects(host.requestInteraction({ ...request, requestId: randomUUID(), sessionId: "other" }), /会话不可用/);
});
