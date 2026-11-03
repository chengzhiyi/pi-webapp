import { randomUUID } from "node:crypto";
import type { ActivityDetail, ActivityItem, ActivityKind, ActivityStatus } from "../contract/activity.ts";
import { ActivityProviderError, errorText, record, text, timestamp, type ActivityEventBus, type ActivityProvider, type ActivityProviderResult } from "./provider.ts";

const REQUEST = "pi-background-tasks:host:request:v1";
const RESPONSE = "pi-background-tasks:host:response:v1";
const CHANGED = "pi-background-tasks:host:changed:v1";
const REQUEST_SCHEMA = "pi-background-tasks.host-request.v1";
const RESPONSE_SCHEMA = "pi-background-tasks.host-response.v1";

interface Lease { leaseId: string; activationId: string }
interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }

function status(value: unknown): ActivityStatus {
  return value === "completed" ? "completed" : value === "failed" ? "failed" : value === "killed" ? "stopped" : "running";
}

function kind(value: unknown, agent: boolean): ActivityKind {
  if (value === "delegate" || value === "fusion" || value === "attested" || value === "managed") return value;
  return agent || value === "agent-shell" ? "agent" : "shell";
}

/** Adapter for pi-background-tasks' public native-host protocol, not its model-facing tools. */
export class BackgroundTasksActivityProvider implements ActivityProvider {
  readonly source = "background-tasks" as const;
  private readonly pending = new Map<string, Pending>();
  private readonly offs: Array<() => void> = [];
  private lease: Lease | null = null;
  private leasePromise: Promise<Lease> | null = null;
  private sequence = 0;
  private closed = false;
  private succeeded = false;
  private lastItems: ActivityItem[] = [];

  private readonly bus: ActivityEventBus;
  private readonly sessionId: string;
  private readonly invalidate: () => void;

  constructor(bus: ActivityEventBus, sessionId: string, invalidate: () => void) {
    this.bus = bus;
    this.sessionId = sessionId;
    this.invalidate = invalidate;
    this.offs.push(this.bus.on(RESPONSE, value => this.response(value)) ?? (() => {}));
    this.offs.push(this.bus.on(CHANGED, value => {
      const frame = record(value);
      if (!frame || frame.sessionId !== this.sessionId) return;
      if (frame.kind === "ready" || frame.kind === "closed" || (this.lease && frame.activationId !== this.lease.activationId)) this.resetLease();
      this.invalidate();
    }) ?? (() => {}));
  }

  private resetLease() { this.lease = null; this.leasePromise = null; this.sequence = 0; }

  private response(value: unknown) {
    const frame = record(value);
    if (!frame || frame.schema_version !== RESPONSE_SCHEMA || typeof frame.request_id !== "string") return;
    const pending = this.pending.get(frame.request_id);
    if (!pending) return;
    this.pending.delete(frame.request_id);
    clearTimeout(pending.timer);
    if (frame.ok === true) pending.resolve(frame.result);
    else {
      const error = record(frame.error);
      pending.reject(new ActivityProviderError(text(error?.message, "Background task operation failed"), text(error?.code, "OPERATION_FAILED")));
    }
  }

  private raw(operation: string, payload: Record<string, unknown>, timeoutMs = 5_000): Promise<unknown> {
    if (this.closed) return Promise.reject(new ActivityProviderError("Background task provider is closed", "CLOSED"));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new ActivityProviderError("Background task provider did not respond", "UNAVAILABLE"));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      try { this.bus.emit(REQUEST, { schema_version: REQUEST_SCHEMA, request_id: requestId, operation, payload }); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private async ensureLease(): Promise<Lease> {
    if (this.lease) return this.lease;
    if (this.leasePromise) return this.leasePromise;
    this.leasePromise = (async () => {
      const result = record(await this.raw("subscribe", { clientId: `pi-webapp:${this.sessionId}`.slice(0, 128) }));
      if (!result || typeof result.leaseId !== "string" || typeof result.activationId !== "string") throw new ActivityProviderError("Invalid background task subscription", "INVALID_RESPONSE");
      this.lease = { leaseId: result.leaseId, activationId: result.activationId };
      this.sequence = 0;
      return this.lease;
    })().finally(() => { this.leasePromise = null; });
    return this.leasePromise;
  }

  private async call(operation: string, input: Record<string, unknown>, timeoutMs = 5_000, retry = true): Promise<unknown> {
    const lease = await this.ensureLease();
    try {
      return await this.raw(operation, { leaseId: lease.leaseId, activationId: lease.activationId, sequence: ++this.sequence, ...input }, timeoutMs);
    } catch (error) {
      const code = error instanceof ActivityProviderError ? error.code : "";
      if (retry && ["LEASE_INVALID", "ACTIVATION_MISMATCH", "CLOSED"].includes(code)) {
        this.resetLease();
        return this.call(operation, input, timeoutMs, false);
      }
      throw error;
    }
  }

  private item(value: unknown): ActivityItem | null {
    const view = record(value);
    const task = record(view?.task);
    if (!view || !task || typeof task.id !== "string") return null;
    const state = status(task.status);
    const usage = record(task.tokenUsage);
    return {
      id: task.id, source: this.source, kind: kind(view.kind, task.isAgent === true),
      title: text(task.name, text(task.command, task.id)), status: state,
      startedAt: timestamp(task.startTime), updatedAt: timestamp(task.endTime) ?? timestamp(task.startTime), endedAt: timestamp(task.endTime),
      ...(state === "running" && text(task.description || task.command) ? { currentAction: text(task.description || task.command) } : {}),
      ...(text(task.model) ? { model: text(task.model) } : {}),
      ...(typeof usage?.totalTokens === "number" ? { tokens: usage.totalTokens } : {}),
      ...(text(task.error) ? { error: text(task.error) } : {}),
      unread: state !== "running" && view.seen === false,
      canStop: state === "running", canRerun: view.canRerun === true, canOpen: true,
    };
  }

  async read(): Promise<ActivityProviderResult> {
    try {
      const result = record(await this.call("list", { limit: 50 }));
      const items = Array.isArray(result?.tasks) ? result.tasks.map(value => this.item(value)).filter((item): item is ActivityItem => item !== null) : [];
      if (!result || !Array.isArray(result.tasks)) throw new ActivityProviderError("Invalid background task list", "INVALID_RESPONSE");
      this.lastItems = items;
      this.succeeded = true;
      return { provider: { source: this.source, available: true }, items };
    } catch (error) {
      return { provider: { source: this.source, available: this.succeeded, error: errorText(error) }, items: this.lastItems };
    }
  }

  async detail(id: string): Promise<ActivityDetail> {
    const result = record(await this.call("detail", { taskId: id }));
    const item = this.item(result?.task);
    if (!item) throw new ActivityProviderError("Background task not found", "NOT_FOUND");
    let output = "";
    let outputPath: string | undefined;
    let truncated = false;
    try {
      const logs = record(await this.call("logs", { taskId: id, maxBytes: 65_536, tail: true }));
      output = text(logs?.text);
      outputPath = text(logs?.path) || undefined;
      truncated = logs?.truncated === true;
    } catch { /* A result-only task may not have a log file. */ }
    const view = record(result?.task);
    if (view?.canReadResult === true) {
      try {
        const resultView = record(await this.call("result", { taskId: id }, 10_000));
        if (resultView?.state === "committed" && text(resultView.text)) output = text(resultView.text);
        else if (resultView?.state === "committed" && text(resultView.artifactPath)) output = `Result artifact: ${text(resultView.artifactPath)}`;
        else if (!output && text(resultView?.message)) output = text(resultView?.message);
      } catch { /* Logs still provide useful detail when no verified result exists. */ }
    }
    if (item.unread) {
      await this.call("mark_seen", { taskIds: [id] }).catch(() => undefined);
      this.invalidate();
    }
    return { item, text: output, truncated, ...(outputPath ? { outputPath } : {}) };
  }

  async stop(id: string): Promise<void> { await this.call("stop", { taskId: id }, 30_000); this.invalidate(); }
  async rerun(id: string): Promise<void> { await this.call("rerun", { taskId: id }, 30_000); this.invalidate(); }

  close() {
    this.closed = true;
    for (const off of this.offs) off();
    this.resetLease();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new ActivityProviderError("Background task provider is closed", "CLOSED"));
    }
    this.pending.clear();
  }
}
