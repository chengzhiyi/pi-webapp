import { randomUUID } from "node:crypto";
import type { ActivityDetail, ActivityItem, ActivityStatus } from "../contract/activity.ts";
import { ActivityProviderError, errorText, record, text, timestamp, type ActivityEventBus, type ActivityProvider, type ActivityProviderResult } from "./provider.ts";

const REQUEST = "subagents:rpc:v1:request";
const READY = "subagents:rpc:v1:ready";
const REPLY = "subagents:rpc:v1:reply:";
const CHANGES = ["subagent:jobs-changed", "subagent:async-started", "subagent:async-complete", "subagent:child-status", "subagent:process-terminal"] as const;

interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }
interface FleetEntry {
  key: string;
  agent: string;
  role?: string;
  model?: string;
  goal?: string;
  startedAt: number;
  tokens: number;
}

function state(value: unknown): ActivityStatus {
  if (value === "complete" || value === "completed") return "completed";
  if (value === "failed" || value === "partial" || value === "rejected") return "failed";
  if (value === "stopped") return "stopped";
  if (value === "paused") return "paused";
  return "running";
}

function fleetEntry(value: unknown): FleetEntry | null {
  const entry = record(value);
  const startedAt = timestamp(entry?.startedAt);
  const tokens = record(entry?.tokens);
  if (!entry || typeof entry.key !== "string" || typeof entry.agent !== "string" || startedAt === null) return null;
  return {
    key: entry.key, agent: entry.agent, startedAt,
    ...(text(entry.role) ? { role: text(entry.role) } : {}),
    ...(text(entry.model) ? { model: text(entry.model) } : {}),
    ...(text(entry.goal) ? { goal: text(entry.goal) } : {}),
    tokens: typeof tokens?.total === "number" ? tokens.total : 0,
  };
}

function descendants(value: unknown): Array<Record<string, unknown>> {
  const node = record(value);
  if (!node) return [];
  return [node, ...(Array.isArray(node.children) ? node.children.flatMap(descendants) : [])];
}

/** Adapter for pi-subagents' public in-process RPC and lifecycle events. */
export class SubagentsActivityProvider implements ActivityProvider {
  readonly source = "subagents" as const;
  private readonly pending = new Map<string, Pending>();
  private readonly offs: Array<() => void> = [];
  private closed = false;
  private succeeded = false;
  private lastItems: ActivityItem[] = [];

  private readonly bus: ActivityEventBus;

  constructor(bus: ActivityEventBus, invalidate: () => void) {
    this.bus = bus;
    this.offs.push(this.bus.on(READY, invalidate) ?? (() => {}));
    for (const event of CHANGES) this.offs.push(this.bus.on(event, invalidate) ?? (() => {}));
  }

  private request(method: "status" | "stop", params: Record<string, unknown>, timeoutMs = 5_000): Promise<unknown> {
    if (this.closed) return Promise.reject(new ActivityProviderError("Subagent provider is closed", "CLOSED"));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      let off = () => {};
      const timer = setTimeout(() => {
        off();
        this.pending.delete(requestId);
        reject(new ActivityProviderError("Subagent provider did not respond", "UNAVAILABLE"));
      }, timeoutMs);
      const pending: Pending = {
        resolve: value => { off(); resolve(value); },
        reject: error => { off(); reject(error); },
        timer,
      };
      this.pending.set(requestId, pending);
      off = this.bus.on(`${REPLY}${requestId}`, value => {
        const reply = record(value);
        if (!reply || reply.requestId !== requestId) return;
        const current = this.pending.get(requestId);
        if (!current) return;
        this.pending.delete(requestId);
        clearTimeout(current.timer);
        if (reply.success === true) current.resolve(reply.data);
        else {
          const error = record(reply.error);
          current.reject(new ActivityProviderError(text(error?.message, "Subagent operation failed"), text(error?.code, "execution_failed")));
        }
      }) ?? (() => {});
      try { this.bus.emit(REQUEST, { version: 1, requestId, method, params, source: { extension: "pi-webapp" } }); }
      catch (error) {
        clearTimeout(timer);
        off();
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private runItem(value: unknown, fleet: FleetEntry[], matched: Set<string>): ActivityItem | null {
    const node = record(value);
    if (!node || typeof node.id !== "string") return null;
    const nodes = descendants(node);
    const active = nodes.slice(1).find(candidate => ["running", "paused", "queued"].includes(String(candidate.state)));
    const fleetMatches: FleetEntry[] = [];
    for (const candidate of nodes) {
      const agent = text(candidate.agent, text(node.agent));
      const startedAt = timestamp(candidate.startedAt);
      const match = agent && startedAt !== null ? fleet.find(entry => !matched.has(entry.key) && entry.agent === agent && entry.startedAt === startedAt) : undefined;
      if (match) { matched.add(match.key); fleetMatches.push(match); }
    }
    const primary = active ?? nodes[1] ?? node;
    const activity = record(primary.activity) ?? record(node.activity);
    const action = text(activity?.currentTool, text(activity?.state, fleetMatches[0]?.goal ?? ""));
    const status = state(node.state);
    const single = nodes.length <= 2 ? fleetMatches[0] : undefined;
    return {
      id: node.id, source: this.source,
      kind: node.kind === "workflow" || nodes.length > 2 ? "workflow" : "agent",
      title: text(node.label, text(primary.agent, "Subagent")), status,
      startedAt: timestamp(node.startedAt) ?? timestamp(primary.startedAt),
      updatedAt: timestamp(node.updatedAt) ?? timestamp(node.endedAt) ?? timestamp(primary.updatedAt),
      endedAt: timestamp(node.endedAt),
      ...(action ? { currentAction: action } : {}),
      ...(text(primary.model, single?.model ?? "") ? { model: text(primary.model, single?.model ?? "") } : {}),
      ...(single ? { tokens: single.tokens } : {}),
      canStop: status === "running" || status === "paused", canRerun: false, canOpen: true,
    };
  }

  async read(): Promise<ActivityProviderResult> {
    try {
      const data = record(await this.request("status", {}));
      if (!data) throw new ActivityProviderError("Invalid subagent status", "INVALID_RESPONSE");
      const snapshot = record(data.asyncSnapshot);
      const fleet = (Array.isArray(record(data.fleet)?.entries) ? record(data.fleet)?.entries : []) as unknown[];
      const entries = fleet.map(fleetEntry).filter((entry): entry is FleetEntry => entry !== null);
      const matched = new Set<string>();
      const runs = Array.isArray(snapshot?.runs) ? snapshot.runs : [];
      const items = runs.map(run => this.runItem(run, entries, matched)).filter((item): item is ActivityItem => item !== null);
      for (const entry of entries) {
        if (matched.has(entry.key)) continue;
        items.push({
          id: `fleet:${entry.key}`, source: this.source, kind: "agent",
          title: entry.role ?? entry.agent, status: "running", startedAt: entry.startedAt, updatedAt: entry.startedAt, endedAt: null,
          ...(entry.goal ? { currentAction: entry.goal } : {}), ...(entry.model ? { model: entry.model } : {}), tokens: entry.tokens,
          canStop: false, canRerun: false, canOpen: false,
        });
      }
      this.lastItems = items;
      this.succeeded = true;
      return { provider: { source: this.source, available: true }, items };
    } catch (error) {
      return { provider: { source: this.source, available: this.succeeded, error: errorText(error) }, items: this.lastItems };
    }
  }

  async detail(id: string): Promise<ActivityDetail> {
    if (id.startsWith("fleet:")) throw new ActivityProviderError("Foreground child details are available in the parent tool call", "INVALID_STATE");
    const data = record(await this.request("status", { id, view: "transcript", lines: 100 }, 10_000));
    if (!data) throw new ActivityProviderError("Subagent run not found", "not_found");
    if (!this.lastItems.some(item => item.id === id)) await this.read();
    const item = this.lastItems.find(candidate => candidate.id === id);
    if (!item) throw new ActivityProviderError("Subagent run not found", "not_found");
    return { item, text: text(data.text), truncated: data.truncated === true };
  }

  async stop(id: string): Promise<void> {
    if (id.startsWith("fleet:")) throw new ActivityProviderError("Foreground children are stopped with their parent turn", "INVALID_STATE");
    await this.request("stop", { id }, 30_000);
  }

  close() {
    this.closed = true;
    for (const off of this.offs) off();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new ActivityProviderError("Subagent provider is closed", "CLOSED"));
    }
    this.pending.clear();
  }
}
