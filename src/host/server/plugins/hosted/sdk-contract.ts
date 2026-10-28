import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

export interface HostedSdkAssessment { supported: boolean; missing: string[] }
/** Test the public registry contract at the initialized SDK seam. An inert hidden
 * declaration cannot read files, invoke plugin code, or reach a provider. It stays
 * hidden in the session registry; no SDK-private imports or version guesses. */
export function assessHostedSdk(pi: ExtensionAPI): HostedSdkAssessment {
  const methods = ["on", "registerTool", "getAllTools", "getActiveTools", "setActiveTools"] as const;
  const missing = methods.filter(name => typeof pi[name] !== "function").map(name => String(name));
  if (missing.length) return { supported: false, missing };
  const name = `__pi_web_contract_${randomUUID().replaceAll("-", "")}`;
  let active: string[];
  try { active = pi.getActiveTools(); if (!Array.isArray(active)) throw new Error(); }
  catch { return { supported: false, missing: ["initialized-tool-registry"] }; }
  const probe: ToolDefinition = { name, label: "Hosted capability check", description: "Internal inert capability check", parameters: { type: "object", properties: {} } as ToolDefinition["parameters"], exposure: "hidden", execute: async () => { throw new Error("Hosted capability check is never executable"); } };
  try {
    pi.registerTool(probe);
    pi.setActiveTools([...active, name]);
    if (pi.getAllTools().find(tool => tool.name === name)?.exposure !== "hidden" || pi.getActiveTools().includes(name)) missing.push("hidden-tool-exposure");
    const parameters = { type: "object", properties: { contract: { type: "boolean" } } } as ToolDefinition["parameters"];
    pi.registerTool({ ...probe, parameters });
    if (pi.getAllTools().find(tool => tool.name === name)?.parameters !== parameters) missing.push("dynamic-tool-registry");
  } catch { missing.push("tool-registry-contract"); }
  finally { try { pi.setActiveTools(active); } catch { missing.push("active-tool-registry"); } }
  return { supported: !missing.length, missing };
}

let verified: Promise<HostedSdkAssessment> | undefined;
/** The SDK has no advertised permission-capability version. Exercise its public
 * execution contract once using inert tools and a deterministic stream. The
 * probe owns an in-memory transcript and a disposable settings directory. It
 * never imports user extensions, credentials, model output, or provider code. */
export function verifyHostedSdkContract(): Promise<HostedSdkAssessment> {
  return verified ??= verifyExecutionContract().catch(() => ({ supported: false, missing: ["sdk-execution-contract"] }));
}
async function verifyExecutionContract(): Promise<HostedSdkAssessment> {
  const { createAgentSession, DefaultResourceLoader, SessionManager } = await import("@earendil-works/pi-coding-agent");
  const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const cwd = await mkdtemp(join(tmpdir(), "pi-sdk-contract-"));
  let session: import("@earendil-works/pi-coding-agent").AgentSession | undefined;
  const missing: string[] = []; let directCalls = 0, protectedCalls = 0, parentSeen = false, checked = false;
  try {
    const definition = (name: string, exposure: ToolDefinition["exposure"], execute: ToolDefinition["execute"]): ToolDefinition => ({ name, label: name, description: "Inert host SDK contract check", exposure, parameters: { type: "object", properties: {} } as ToolDefinition["parameters"], execute });
    const result = () => ({ content: [], details: undefined });
    const loader = new DefaultResourceLoader({ cwd, agentDir: cwd, noExtensions: true, noSkills: true, noPromptTemplates: true, extensionFactories: [pi => {
      pi.on("tool_call", event => {
        if (event.toolName === "__contract_direct") parentSeen = !!event.parentToolCallId;
        if (event.toolName === "__contract_protected") return { block: true, reason: "Inert host permission check" };
      });
      for (const exposure of ["hidden", "model-only"] as const) pi.registerTool(definition(`__contract_${exposure.replace("-", "_")}`, exposure, async () => { protectedCalls++; return result(); }));
      pi.registerTool(definition("__contract_protected", "direct", async () => { protectedCalls++; return result(); }));
      pi.registerTool(definition("__contract_direct", "direct", async () => { directCalls++; return result(); }));
      pi.registerTool(definition("__contract_driver", "direct", async (_id, _args, _signal, _update, ctx) => {
        const hidden = await ctx.executeTool("__contract_hidden", {}), modelOnly = await ctx.executeTool("__contract_model_only", {});
        const allowed = await ctx.executeTool("__contract_direct", {}), denied = await ctx.executeTool("__contract_protected", {});
        if (!hidden.isError || !modelOnly.isError) missing.push("nested-tool-exposure");
        if (allowed.isError || directCalls !== 1) missing.push("nested-tool-execution");
        if (!denied.isError || protectedCalls !== 0) missing.push("nested-tool-permission-guard");
        if (!parentSeen) missing.push("nested-parent-identity");
        checked = true; return result();
      }));
    }] });
    await loader.reload();
    ({ session } = await createAgentSession({ cwd, agentDir: cwd, sessionManager: SessionManager.inMemory(cwd), resourceLoader: loader }));
    await session.bindExtensions({ mode: "print" });
    const model = session.modelRuntime.getModels("openai")[0];
    if (!model) return { supported: false, missing: ["sdk-model-contract"] };
    await session.modelRuntime.setRuntimeApiKey("openai", "inert-sdk-contract-check"); await session.setModel(model);
    let turn = 0;
    session.agent.streamFunction = async selected => {
      const first = turn++ === 0;
      const message: import("@earendil-works/pi-ai").AssistantMessage = { role: "assistant", api: selected.api, provider: selected.provider, model: selected.id, timestamp: Date.now(), content: first ? [{ type: "toolCall", id: "contract-parent", name: "__contract_driver", arguments: {} }] : [{ type: "text", text: "Inert contract complete" }], stopReason: first ? "toolUse" : "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream(); stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: first ? "toolUse" : "stop", message }); stream.end(message); return stream;
    };
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([session.prompt("Inert in-memory SDK permission contract check"), new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error("SDK permission contract check timed out")), 5000);
      })]);
    } finally { clearTimeout(deadline); }
    if (!checked) missing.push("sdk-tool-context");
    return { supported: !missing.length, missing };
  } finally { session?.dispose(); await rm(cwd, { recursive: true, force: true }); }
}
