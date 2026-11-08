// pi-pencil spike end to end through the REAL host: authenticated HTTP bridge, manager + forked
// worker running the packed plugin, retained SDK AgentSession (scripted model stream), per-plugin
// CSP on served assets, image tool results, human-only accept and binary .fig save via the broker.
// Needs PI_PENCIL_TGZ (packed @chengzhiyi/pi-pencil); skipped otherwise.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { createAssistantMessageEventStream, type AssistantMessage, type ToolCall } from "@earendil-works/pi-ai";
import { HostedPluginIntegration } from "../src/host/server/plugins/hosted/integration.ts";
import { WorkspaceSessions } from "../src/host/server/sessions/workspace-sessions.ts";
import { startBridge } from "../src/host/server/transport/bridge.ts";
import { NodeTelemetry } from "../src/platform/telemetry/telemetry.ts";
import { terminalHost } from "./helpers/terminal-host.ts";
import { OFFICIAL_PLUGINS } from "../src/host/server/plugins/hosted/official-catalog.ts";

const TGZ = process.env.PI_PENCIL_TGZ ?? "";
const ID = "@chengzhiyi/pi-pencil";
const catalog = OFFICIAL_PLUGINS.filter(plugin => plugin.id === ID);
const LOGIN = [
  { op: "create", ref: "$screen", parent: "$page", type: "FRAME", props: { name: "Login", width: 390, height: 844, fill: "#FFFFFF", layout: { mode: "VERTICAL", gap: 16, padding: { top: 64, right: 24, bottom: 24, left: 24 } } } },
  { op: "create", ref: "$title", parent: "$screen", type: "TEXT", props: { name: "Title", text: { content: "登录 / ログイン", font: { family: "Noto Sans SC", style: "Bold", size: 28 }, color: "#111827" } } },
  { op: "create", ref: "$email", parent: "$screen", type: "FRAME", props: { name: "Email", fill: "#F3F4F6", radius: 12, sizingH: "FILL", layout: { mode: "HORIZONTAL", padding: { top: 14, right: 16, bottom: 14, left: 16 } } } },
  { op: "create", ref: "$emailText", parent: "$email", type: "TEXT", props: { text: { content: "邮箱 Email", font: { size: 16 }, color: "#9CA3AF" }, sizingH: "FILL" } },
  { op: "create", ref: "$button", parent: "$screen", type: "FRAME", props: { name: "Primary button", fill: "#4F46E5", radius: 12, sizingH: "FILL", layout: { mode: "HORIZONTAL", justify: "CENTER", align: "CENTER", padding: { top: 14, bottom: 14 } } } },
  { op: "create", ref: "$buttonText", parent: "$button", type: "TEXT", props: { text: { content: "登录", font: { style: "Medium", size: 16 }, color: "#FFFFFF" } } },
];

test("pi-pencil through the real host: install, CSP, agent tools with images, human accept, .fig save", { timeout: 120_000, skip: !TGZ || !existsSync(TGZ) ? "set PI_PENCIL_TGZ" : false }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hosted-pencil-")));
  const prior = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const workerEntry = join(root, "worker.mjs");
  await build({ entryPoints: [new URL("../src/host/server/plugins/hosted/worker-entry.ts", import.meta.url).pathname], outfile: workerEntry, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
  let sessions!: WorkspaceSessions;
  const scope = (cwd: string, sessionId: string) => ({ cwd, sessionId, workspaceId: "trusted-workspace" });
  const integration = new HostedPluginIntegration({ root: join(root, "hosted"), hostVersion: "0.1.52", workerEntry, ownerId: "owner", catalog,
    devArchives: new Map([[ID, TGZ]]),
    resolveSession: (sessionId: string) => { const r = sessions?.hostedScope(sessionId); return r ? scope(r.cwd, sessionId) : null; },
    fetch: (async () => { throw new Error("no registry access in this test"); }) as typeof fetch });
  sessions = new WorkspaceSessions(() => {}, () => undefined, () => false, undefined, undefined, undefined, [], { adapter: integration.adapter, scope });
  await integration.start();
  await sessions.open(root, "new"); const session = sessions.session!, sessionId = session.sessionManager.getSessionId();
  const { host } = terminalHost(root); host.hosted = integration.handlers;
  const bridge = await startBridge(host, new URL("../web/dist", import.meta.url).pathname, new NodeTelemetry({ env: { PI_WEB_SENTRY_ENABLED: "false" }, monitor: false }), { pluginSettingsFile: join(root, "preferences.json") });
  t.after(async () => { integration.adapter.thaw(); await integration.shutdown(); await bridge.close(); await sessions.dispose(); if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior; await rm(root, { recursive: true, force: true }); });
  const url = new URL(bridge.url), headers = { Authorization: `Bearer ${url.hash.slice(1)}`, Origin: url.origin, "Content-Type": "application/json" };
  const post = async (route: string, body: unknown) => { const r = await fetch(url.origin + "/api/hosted-plugins/" + route, { method: "POST", headers, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };

  const timings: Record<string, number> = {}; let t0 = performance.now();
  const installed = await post("manage", { pluginId: ID, operation: "install" }); assert.equal(installed.status, 200, JSON.stringify(installed.body).slice(0, 600));
  const enabled = await post("manage", { pluginId: ID, operation: "enable" }); assert.equal(enabled.status, 200, JSON.stringify(enabled.body).slice(0, 400));
  timings.installEnableMs = Math.round(performance.now() - t0);
  const card = enabled.body.plugins.find((p: { pluginId: string }) => p.pluginId === ID);
  assert.ok(card.enabled && card.documentUrl, "pencil enabled with a served document");

  // H1/H2: per-plugin CSP on the frame document and its WASM, with the right MIME type.
  const doc = await fetch(url.origin + card.documentUrl);
  assert.equal(doc.status, 200);
  assert.match(doc.headers.get("content-security-policy")!, /script-src 'self' 'wasm-unsafe-eval';/);
  assert.doesNotMatch(doc.headers.get("content-security-policy")!, /'unsafe-eval'/);
  const html = await doc.text();
  const base = new URL(card.documentUrl, url.origin);
  const scriptSrc = /<script[^>]+src="([^"]+)"/.exec(html)![1]!;
  const js = await fetch(new URL(scriptSrc, base));
  assert.equal(js.status, 200); assert.match(js.headers.get("content-security-policy")!, /'wasm-unsafe-eval'/);
  const wasmName = /canvaskit-[\w-]+\.wasm/.exec(await js.text() + await (async () => { const chunks = [...html.matchAll(/href="([^"]+\.js)"/g)].map(m => m[1]); let s = ""; for (const c of chunks) s += await (await fetch(new URL(c!, base))).text(); return s; })())?.[0];
  if (wasmName) { const w = await fetch(new URL(`assets/${wasmName}`, base)); assert.equal(w.status, 200); assert.equal(w.headers.get("content-type"), "application/wasm"); }

  // Agent: read_me → propose (scripted model stream; tool execution is real).
  assert.ok(session.getActiveToolNames().includes("pencil_propose_changes"));
  const model = session.modelRuntime.getModels("openai")[0]!;
  await session.modelRuntime.setRuntimeApiKey("openai", "fixture-no-network"); await session.setModel(model);
  let stage = 0;
  session.agent.streamFunction = async m => {
    stage++;
    const content: AssistantMessage["content"] = stage === 1 ? [{ type: "toolCall" as const, id: "c1", name: "pencil_read_me", arguments: {} }]
      : stage === 2 ? [{ type: "toolCall" as const, id: "c2", name: "pencil_propose_changes", arguments: { title: "Login", ops: LOGIN } as unknown as ToolCall["arguments"] }]
      : [{ type: "text" as const, text: "Proposed a login screen; please review it." }];
    const message: AssistantMessage = { role: "assistant", api: m.api, provider: m.provider, model: m.id, timestamp: Date.now(), content, stopReason: stage < 3 ? "toolUse" : "stop",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = createAssistantMessageEventStream(); stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: message.stopReason as "toolUse" | "stop", message }); stream.end(message); return stream;
  };
  t0 = performance.now();
  await session.prompt("Design a mobile login screen");
  timings.agentTurnMs = Math.round(performance.now() - t0);
  const results = session.messages.filter(m => m.role === "toolResult");
  const proposeResult = results.find(m => m.role === "toolResult" && m.toolCallId === "c2");
  assert.ok(proposeResult && proposeResult.role === "toolResult" && !proposeResult.isError, JSON.stringify(proposeResult).slice(0, 600));
  const image = proposeResult.content.find(c => c.type === "image");
  assert.ok(image && image.type === "image" && image.mimeType === "image/png", "H4: the agent sees the rendered preview");
  const proposal = JSON.parse((proposeResult.content.find(c => c.type === "text") as { text: string }).text);
  assert.equal(proposal.status, "pending_review");

  // Human (frame action over authenticated HTTP) accepts and saves; the agent cannot.
  const generation = (await integration.inventory()).plugins.find(p => p.pluginId === ID)!.generation!;
  const action = (name: string, input: unknown) => post("action", { pluginId: ID, generation, sessionId, action: name, input });
  assert.equal((await action("get", { docId: proposal.docId })).body.value?.rev ?? (await action("get", { docId: proposal.docId })).body.rev, 0);
  const accepted = await action("accept", { docId: proposal.docId, proposalId: proposal.proposalId });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  const saved = await action("save", { docId: proposal.docId, path: "designs/login.fig" });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const onDisk = await readFile(join(root, "designs/login.fig"));
  assert.equal(createHash("sha256").update(onDisk).digest("hex"), (saved.body.value ?? saved.body).hash);
  const conflict = await action("save", { docId: proposal.docId, path: "designs/login.fig" });
  assert.equal(conflict.status, 200, "same content, known hash: idempotent save");
  console.log(JSON.stringify({ timings, figBytes: onDisk.length, previewBytes: Buffer.from((image as { data: string }).data, "base64").length }));
});
