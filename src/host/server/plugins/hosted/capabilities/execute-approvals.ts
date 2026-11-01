import { randomUUID } from "node:crypto";
import { HostedPluginError } from "../errors.ts";

export interface ExecuteApproval { id: string; pluginId: string; sessionId: string; title: string }
type Entry = ExecuteApproval & { status: "pending" | "allowed" | "denied"; decidedAt?: number };
const DENY_COOLDOWN_MS = 60_000;
/** The human gate for lifting a plugin session's read-only restriction. Only `decide`, called from an authenticated browser request, can grant. */
export class ExecuteApprovals {
  private readonly entries = new Map<string, Entry>();
  private readonly options: { describe?(sessionId: string): string | undefined; changed?(): void; now?(): number };
  constructor(options: { describe?(sessionId: string): string | undefined; changed?(): void; now?(): number } = {}) { this.options = options; }
  private now() { return this.options.now?.() ?? Date.now(); }
  pending(): ExecuteApproval[] {
    return [...this.entries.values()].filter(e => e.status === "pending").map(({ id, pluginId, sessionId, title }) => ({ id, pluginId, sessionId, title }));
  }
  /** Resolves when approved; otherwise throws and (re)queues a request the user can see. The plugin retries later. */
  async authorize(pluginId: string, sessionId: string): Promise<true> {
    const entry = this.entries.get(sessionId);
    if (entry && entry.pluginId !== pluginId) throw new HostedPluginError("execute_denied", "Session belongs to another plugin", { status: 403 });
    if (entry?.status === "allowed") return true;
    if (entry?.status === "pending") throw new HostedPluginError("approval_required", "Waiting for the user to approve execution", { status: 409 });
    if (entry?.status === "denied" && this.now() - entry.decidedAt! < DENY_COOLDOWN_MS) throw new HostedPluginError("execute_denied", "The user denied execution", { status: 403 });
    this.entries.set(sessionId, { id: randomUUID(), pluginId, sessionId, title: this.options.describe?.(sessionId) ?? sessionId, status: "pending" });
    this.options.changed?.();
    throw new HostedPluginError("approval_required", "Waiting for the user to approve execution", { status: 409 });
  }
  decide(id: string, allow: boolean): void {
    const entry = [...this.entries.values()].find(e => e.id === id && e.status === "pending");
    if (!entry) throw new HostedPluginError("unknown_approval", "No such pending approval", { status: 404 });
    entry.status = allow ? "allowed" : "denied"; entry.decidedAt = this.now();
    this.options.changed?.();
  }
  /** Grants die with the session. */
  forget(sessionId: string): void { if (this.entries.delete(sessionId)) this.options.changed?.(); }
}
