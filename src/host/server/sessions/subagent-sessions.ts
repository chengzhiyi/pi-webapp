import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { parseSessionEntries, type SessionInfo } from "@earendil-works/pi-coding-agent";
import type { SubagentSessionView, ViewMessage } from "../../../contracts/bridge-contract.ts";
import { projectEntry } from "./view.ts";

interface Dispatch {
  agentId: string;
  agentType: string;
  dispatchCallId: string;
  description?: string;
  prompt: string;
  status: SubagentSessionView["status"];
  steering: string[];
}
export interface SubagentEvidence {
  view: SubagentSessionView;
  prompt: string;
  steering: string[];
}

function statusOf(status: unknown): SubagentSessionView["status"] {
  switch (status) {
    case "background": case "running": return "running";
    case "completed": return "completed";
    case "error": case "failed": case "launch-error": return "failed";
    case "stopped": case "aborted": case "cancelled": return "cancelled";
    default: return "unknown";
  }
}
const descriptionOf = (value: unknown) => typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 160) || undefined : undefined;

/** Index only correlated tool calls/results, never a session's title or parent pointer alone. */
async function readDispatches(path: string) {
  const dispatches = new Map<string, Dispatch>();
  const calls = new Map<string, { name: string; args: Record<string, unknown> }>();
  const final = new Map<string, { status: SubagentSessionView["status"]; description?: string }>();
  const steering: { agentId: string; text: string }[] = [];
  const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.includes('"Agent"') && !line.includes('"steer_subagent"') && !line.includes('"subagents:record"')) continue;
    const entry = parseSessionEntries(line)[0];
    if (!entry) continue;
    if (entry.type === "custom" && entry.customType === "subagents:record") {
      const data = entry.data as Record<string, unknown> | undefined;
      if (typeof data?.id === "string") final.set(data.id, { status: statusOf(data.status), description: descriptionOf(data.description) });
    }
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "toolCall" && (block.name === "Agent" || block.name === "steer_subagent")) calls.set(block.id, { name: block.name, args: block.arguments });
      }
    }
    if (message.role !== "toolResult" || message.isError) continue;
    const call = calls.get(message.toolCallId);
    if (!call || call.name !== message.toolName) continue;
    calls.delete(message.toolCallId);
    if (call.name === "steer_subagent") {
      const response = message.content.find((part) => part.type === "text")?.text;
      const agentId = /^Steering message sent to agent ([\w-]+)\./.exec(response ?? "")?.[1];
      if (agentId && typeof call.args.message === "string") steering.push({ agentId, text: call.args.message });
      continue;
    }
    const details = message.details as Record<string, unknown> | undefined;
    const agentId = details?.agentId;
    const agentType = details?.subagentType ?? call.args.subagent_type;
    if (typeof agentId !== "string" || typeof agentType !== "string" || typeof call.args.prompt !== "string") continue;
    dispatches.set(agentId, { agentId, agentType, dispatchCallId: message.toolCallId, prompt: call.args.prompt, status: statusOf(details?.status), description: descriptionOf(details?.description ?? call.args.description), steering: [] });
  }
  for (const [agentId, record] of final) {
    const dispatch = dispatches.get(agentId);
    if (dispatch) { dispatch.status = record.status; dispatch.description = record.description ?? dispatch.description; }
  }
  for (const { agentId, text } of steering) dispatches.get(agentId)?.steering.push(text);
  return [...dispatches.values()];
}

// Session lists refresh throughout a run. Only reread a referenced parent when its file changes.
const parentCache = new Map<string, { key: string; value: Promise<Dispatch[]> }>();
async function cachedDispatches(path: string) {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) return [];
  const key = `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
  const previous = parentCache.get(path);
  if (previous?.key === key) return previous.value;
  const value = readDispatches(path).catch(() => { if (parentCache.get(path)?.key === key) parentCache.delete(path); return []; });
  parentCache.set(path, { key, value });
  if (parentCache.size > 256) parentCache.delete(parentCache.keys().next().value!);
  return value;
}

export async function identifySubagentSessions(saved: readonly SessionInfo[], trashDirectory: string, runningParents: ReadonlySet<string> = new Set()) {
  const byPath = new Map(saved.map((session) => [session.path, session]));
  const byId = new Map<string, SubagentEvidence>();
  const candidates = saved.filter((session) => session.parentSessionPath && /#[a-f\d]{8}$/i.test(session.name ?? ""));
  const trashed = candidates.some((session) => !byPath.has(session.parentSessionPath!))
    ? await readdir(trashDirectory, { withFileTypes: true }).catch(() => []) : [];
  const trashedByName = new Map(trashed.filter((entry) => entry.isFile() && /^\d+_.+\.jsonl$/.test(entry.name))
    .map(({ name }) => [name.replace(/^\d+_/, ""), join(trashDirectory, name)]));
  const referenced = new Map<string, Promise<Dispatch[]>>();
  for (const child of candidates) {
    const parentPath = child.parentSessionPath!;
    const parent = byPath.get(parentPath);
    // Never read an arbitrary path from a session header. Only listed sessions or files in Pi Web trash.
    const path = parent?.path ?? trashedByName.get(basename(parentPath));
    if (!path || path === child.path) continue;
    let dispatches = referenced.get(path);
    if (!dispatches) { dispatches = cachedDispatches(path); referenced.set(path, dispatches); }
    const matches = (await dispatches).filter((dispatch) => child.name?.endsWith(`#${dispatch.agentId.slice(0, 8)}`) && child.firstMessage === dispatch.prompt);
    if (matches.length !== 1) continue;
    const { agentId, agentType, dispatchCallId, description, status, prompt, steering } = matches[0]!;
    byId.set(child.id, { prompt, steering, view: { parentSessionId: parent?.id ?? null, agentId, agentType, dispatchCallId, description,
      status: status === "running" && !(parent && runningParents.has(parent.id)) ? "unknown" : status } });
  }
  return byId;
}

export async function readSubagentMessages(path: string, id: string, evidence: SubagentEvidence): Promise<ViewMessage[]> {
  const [header, ...entries] = parseSessionEntries(await readFile(path, "utf8"));
  if (header?.type !== "session" || header.id !== id) throw new Error("子任务记录不可用");
  const messages: ViewMessage[] = [];
  const pending = [...evidence.steering];
  const history = entries.filter(entry => entry.type !== "session");
  const byId = new Map(history.map(entry => [entry.id, entry]));
  const branch: typeof history = [];
  for (let entry = history.at(-1); entry && byId.delete(entry.id); entry = entry.parentId ? byId.get(entry.parentId) : undefined) branch.push(entry);
  let sawUser = false;
  for (const entry of branch.reverse()) {
    const message = projectEntry(entry);
    if (!message) continue;
    if (message.role === "user") {
      const text = message.blocks.every((block) => block.kind === "text") ? message.blocks.map((block) => block.text).join(" ") : undefined;
      if (!sawUser && text === evidence.prompt) message.subagentInput = "dispatch";
      else {
        const index = text === undefined ? -1 : pending.indexOf(text);
        if (index >= 0) { message.subagentInput = "steering"; pending.splice(index, 1); }
      }
      sawUser = true;
    }
    messages.push(message);
  }
  return messages;
}
