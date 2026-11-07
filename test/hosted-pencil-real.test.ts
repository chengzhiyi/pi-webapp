// pi-pencil spike S2 with a REAL model: same real host stack as hosted-pencil-e2e, but the
// AgentSession streams from the user's configured provider. Opt-in only:
//   PI_PENCIL_REAL=1 PI_PENCIL_TGZ=<tgz> PI_PENCIL_REAL_OUT=<dir> [PI_PENCIL_PROVIDER/MODEL]
// Uses an isolated agent dir: symlinks to the user's auth.json/models-store.json, minimal settings.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm, readFile, writeFile, mkdir, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { HostedPluginIntegration } from "../src/host/server/plugins/hosted/integration.ts";
import { WorkspaceSessions } from "../src/host/server/sessions/workspace-sessions.ts";
import { startBridge } from "../src/host/server/transport/bridge.ts";
import { NodeTelemetry } from "../src/platform/telemetry/telemetry.ts";
import { terminalHost } from "./helpers/terminal-host.ts";
import type { OfficialPlugin } from "../src/host/server/plugins/hosted/official-catalog.ts";

const TGZ = process.env.PI_PENCIL_TGZ ?? "", OUT = process.env.PI_PENCIL_REAL_OUT ?? "";
const PROVIDER = process.env.PI_PENCIL_PROVIDER ?? "openai-codex", MODEL = process.env.PI_PENCIL_MODEL ?? "gpt-5.5";
const ID = "@chengzhiyi/pi-pencil";
const catalog: OfficialPlugin[] = [{ id: ID, name: "Pencil", icon: "drawing", description: { zh: "UI 设计", en: "UI design" }, registry: "https://registry.npmjs.org", recommendedVersion: "0.0.0", requiredCapabilities: ["state", "workspace", "panels", "browser.wasm"] }];
const PROMPT = process.env.PI_PENCIL_PROMPT ?? "Design a mobile login screen for a Chinese note-taking app called 「轻记」: title, short subtitle, phone number and password inputs, a primary 登录 button, and a 忘记密码？ link. Use the Pencil design tools.";

test("real model drives pi-pencil through the real host", { timeout: 600_000, skip: process.env.PI_PENCIL_REAL !== "1" || !existsSync(TGZ) ? "set PI_PENCIL_REAL=1 and PI_PENCIL_TGZ" : false }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hosted-pencil-real-")));
  const agentDir = join(root, "agent"), userAgent = join(homedir(), ".pi/agent");
  await mkdir(agentDir, { recursive: true });
  for (const f of ["auth.json", "models-store.json"]) if (existsSync(join(userAgent, f))) await symlink(join(userAgent, f), join(agentDir, f));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: PROVIDER, defaultModel: MODEL, packages: [], extensions: [] }));
  const prior = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agentDir;
  const workerEntry = join(root, "worker.mjs");
  await build({ entryPoints: [new URL("../src/host/server/plugins/hosted/worker-entry.ts", import.meta.url).pathname], outfile: workerEntry, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
  let sessions!: WorkspaceSessions;
  const scope = (cwd: string, sessionId: string) => ({ cwd, sessionId, workspaceId: "trusted-workspace" });
  const integration = new HostedPluginIntegration({ root: join(root, "hosted"), hostVersion: "0.1.52", workerEntry, ownerId: "owner", catalog,
    devArchives: new Map([[ID, TGZ]]),
    resolveSession: (sessionId: string) => { const r = sessions?.hostedScope(sessionId); return r ? scope(r.cwd, sessionId) : null; },
    fetch: (async () => { throw new Error("no registry access"); }) as typeof fetch });
  sessions = new WorkspaceSessions(() => {}, () => undefined, () => false, undefined, undefined, undefined, [], { adapter: integration.adapter, scope });
  await integration.start();
  const workspace = join(root, "workspace"); await mkdir(workspace);
  await sessions.open(workspace, "new"); const session = sessions.session!, sessionId = session.sessionManager.getSessionId();
  const { host } = terminalHost(workspace); host.hosted = integration.handlers;
  const bridge = await startBridge(host, new URL("../web/dist", import.meta.url).pathname, new NodeTelemetry({ env: { PI_WEB_SENTRY_ENABLED: "false" }, monitor: false }), { pluginSettingsFile: join(root, "preferences.json") });
  t.after(async () => { integration.adapter.thaw(); await integration.shutdown(); await bridge.close(); await sessions.dispose(); if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior; await rm(root, { recursive: true, force: true }); });
  const url = new URL(bridge.url), headers = { Authorization: `Bearer ${url.hash.slice(1)}`, Origin: url.origin, "Content-Type": "application/json" };
  const post = async (route: string, body: unknown) => { const r = await fetch(url.origin + "/api/hosted-plugins/" + route, { method: "POST", headers, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  assert.equal((await post("manage", { pluginId: ID, operation: "install" })).status, 200);
  assert.equal((await post("manage", { pluginId: ID, operation: "enable" })).status, 200);

  const model = session.modelRuntime.getModels(PROVIDER).find(m => m.id === MODEL);
  assert.ok(model, `model ${PROVIDER}/${MODEL} not available`);
  await session.setModel(model);
  const t0 = performance.now();
  await session.prompt(PROMPT);
  const turnMs = Math.round(performance.now() - t0);
  const lastAssistant = session.messages.filter(m => m.role === "assistant").at(-1) as { stopReason?: string; errorMessage?: string } | undefined;
  if (lastAssistant?.stopReason === "error") console.log("MODEL ERROR:", String(lastAssistant.errorMessage).slice(0, 1500));

  await mkdir(OUT || join(root, "out"), { recursive: true });
  const out = OUT || join(root, "out");
  const calls: Array<{ name: string; ok: boolean; args?: unknown; text?: string; images: number }> = [];
  let imageIndex = 0;
  for (const m of session.messages) {
    if (m.role === "assistant") for (const c of m.content) if (c.type === "toolCall") calls.push({ name: c.name, ok: true, args: c.arguments, images: 0, ...{ id: c.id } } as never);
    if (m.role === "toolResult") {
      const call = calls.find(c => (c as unknown as { id: string }).id === m.toolCallId);
      const text = m.content.filter(c => c.type === "text").map(c => (c as { text: string }).text).join("\n");
      const images = m.content.filter(c => c.type === "image") as Array<{ data: string }>;
      for (const img of images) await writeFile(join(out, `result-${++imageIndex}-${m.toolName}.png`), Buffer.from(img.data, "base64"));
      if (call) { call.ok = !m.isError; call.text = text.slice(0, 1500); call.images = images.length; }
    }
  }
  const finalText = session.messages.filter(m => m.role === "assistant").flatMap(m => m.content.filter(c => c.type === "text").map(c => (c as { text: string }).text)).join("\n").slice(-2000);
  const pencilCalls = calls.filter(c => c.name.startsWith("pencil_"));
  const firstValid = pencilCalls.findIndex(c => c.name === "pencil_propose_changes" && c.ok);

  // Human accepts the latest pending proposal and saves; render the accepted design for review.
  const generation = (await integration.inventory()).plugins.find(p => p.pluginId === ID)!.generation!;
  const action = (name: string, input: unknown) => post("action", { pluginId: ID, generation, sessionId, action: name, input });
  const designs = (await action("list", {})).body;
  const list = (designs.value ?? designs) as Array<{ docId: string; pending: number }>;
  const summary: Record<string, unknown> = { provider: PROVIDER, model: MODEL, turnMs, toolCalls: calls.map(c => `${c.name}${c.ok ? "" : " (error)"}`), pencilCallsToFirstValidProposal: firstValid < 0 ? null : firstValid + 1, designs: list };
  for (const d of list) {
    const got = (await action("get", { docId: d.docId })).body; const doc = got.value ?? got;
    const pending = doc.proposals.filter((p: { status: string }) => p.status === "pending");
    const last = pending.at(-1);
    if (!last) continue;
    const accepted = await action("accept", { docId: d.docId, proposalId: last.id });
    const saved = accepted.status === 200 ? await action("save", { docId: d.docId, path: `designs/${d.docId}.fig` }) : null;
    summary[`accept:${d.docId}`] = { status: accepted.status, body: accepted.body, saved: saved && { status: saved.status, bytes: (saved.body.value ?? saved.body).bytes } };
    if (saved?.status === 200) await writeFile(join(out, `${d.docId}.fig`), await readFile(join(workspace, `designs/${d.docId}.fig`)));
  }
  await writeFile(join(out, "transcript.json"), JSON.stringify({ summary, calls, finalText }, null, 2));
  console.log(JSON.stringify({ ...summary, finalText: finalText.slice(-600) }, null, 2));
  assert.ok(firstValid >= 0, "the model produced a valid pencil proposal");
});
