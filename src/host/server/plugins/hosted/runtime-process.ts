import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { HostedInvocation, HostedToolDescriptor } from "@chengzhiyi/pi-web-protocol";
import type { HostedPackage } from "./resources.ts";
import { HostedPluginError, failure } from "./errors.ts";

export const MAX_HOSTED_MESSAGE_BYTES = 192 * 1024 * 1024;
export type BrokerCall = (invocation: HostedInvocation, method: string, input: unknown) => Promise<unknown>;
interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  invocation?: HostedInvocation;
  expired: boolean;
}
/** A reliable lifecycle boundary, NOT an OS-permission sandbox for hostile code. */
export class HostedRuntimeProcess {
  private readonly child: ChildProcess;
  private readonly pending = new Map<string, Pending>();
  private readonly events = new EventEmitter();
  private stopped = false;
  private unhealthy = false;
  private closing = false;
  readonly generation: number;
  readonly package: HostedPackage;
  tools: HostedToolDescriptor[] = [];

  private readonly broker: BrokerCall;
  private constructor(pkg: HostedPackage, generation: number, entry: string, broker: BrokerCall) {
    this.package = pkg; this.generation = generation; this.broker = broker;
    const env: NodeJS.ProcessEnv = {};
    // In particular do not inherit PI_*, PAPERCLIP_*, tokens, NODE_OPTIONS or user npm configuration.
    for (const key of ["LANG", "LC_ALL", "TZ", "TMPDIR", "TMP", "TEMP", "SystemRoot", "WINDIR"]) if (process.env[key]) env[key] = process.env[key];
    this.child = fork(entry, [], { env, execArgv: [], cwd: pkg.root, stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "json" });
    this.child.on("message", message => { void this.receive(message); });
    this.child.once("error", error => this.fail(error));
    this.child.once("exit", () => this.fail(new HostedPluginError("worker_exited", "Plugin process exited")));
  }
  get pid(): number | undefined { return this.child.pid; }
  get inFlight(): number { return [...this.pending.values()].filter(p => !!p.invocation).length; }
  get healthy(): boolean { return !this.stopped && !this.unhealthy && !this.closing; }

  static async start(pkg: HostedPackage, generation: number, workerEntry: string, broker: BrokerCall, timeoutMs = 10_000): Promise<HostedRuntimeProcess> {
    const worker = new HostedRuntimeProcess(pkg, generation, workerEntry, broker);
    try {
      await worker.request("initialize", { entry: join(pkg.root, pkg.manifest.backend.entry.slice(2)), pluginId: pkg.id, version: pkg.version, generation }, timeoutMs);
      const description = await worker.request("describe", undefined, timeoutMs) as { tools?: HostedToolDescriptor[] };
      if (!description || !Array.isArray(description.tools) || description.tools.length > 128) throw new HostedPluginError("invalid_tools", "Invalid hosted tool catalog");
      const names = new Set<string>();
      for (const tool of description.tools) {
        if (!tool || typeof tool.name !== "string" || !/^[A-Za-z_][\w-]{0,79}$/.test(tool.name) || names.has(tool.name)
          || typeof tool.label !== "string" || typeof tool.description !== "string" || typeof tool.action !== "string" || !/^[\w.-]{1,80}$/.test(tool.action)
          || !tool.parameters || typeof tool.parameters !== "object" || Array.isArray(tool.parameters) || tool.parameters.type !== "object") throw new HostedPluginError("invalid_tools", "Invalid or duplicate tool descriptor");
        names.add(tool.name);
      }
      worker.tools = structuredClone(description.tools);
      await worker.request("health", undefined, timeoutMs);
      return worker;
    } catch (error) { await worker.dispose(); throw error; }
  }
  private fail(error: Error) {
    this.stopped = true;
    for (const value of this.pending.values()) { clearTimeout(value.timer); value.reject(error); }
    this.pending.clear(); this.events.emit("idle");
  }
  private async receive(raw: unknown): Promise<void> {
    if (!raw || typeof raw !== "object" || this.stopped) return;
    let bytes: number;
    try { bytes = Buffer.byteLength(JSON.stringify(raw)); } catch { return; }
    if (bytes > MAX_HOSTED_MESSAGE_BYTES) { this.unhealthy = true; return; }
    const m = raw as Record<string, unknown>;
    if (m.type === "response" && typeof m.id === "string") {
      const item = this.pending.get(m.id);
      if (!item) return;
      clearTimeout(item.timer); this.pending.delete(m.id);
      if (!item.expired) {
        const e = m.error as { code?: string; message?: string; status?: number; reason?: string } | undefined;
        if (m.ok === true) item.resolve(m.value); else item.reject(new HostedPluginError(e?.code ?? "plugin_failed", e?.message ?? "Plugin request failed", e));
      }
      if (!this.inFlight) this.events.emit("idle");
    } else if (m.type === "broker-request" && typeof m.id === "string" && typeof m.invocationId === "string" && typeof m.method === "string") {
      const item = this.pending.get(m.invocationId);
      try {
        if (!item?.invocation || item.expired) throw new HostedPluginError("invalid_lease", "Plugin invocation lease is no longer writable");
        const value = await this.broker(item.invocation, m.method, m.input);
        if (this.child.connected) this.child.send({ type: "broker-response", id: m.id, ok: true, value });
      } catch (error) { if (this.child.connected) this.child.send({ type: "broker-response", id: m.id, ok: false, error: failure(error) }); }
    }
  }
  private request(method: string, input?: unknown, timeoutMs = 30_000, invocation?: HostedInvocation): Promise<unknown> {
    if (this.stopped || this.closing && method !== "dispose") return Promise.reject(new HostedPluginError("worker_closed", "Plugin process is not available"));
    if (this.pending.size >= 64) return Promise.reject(new HostedPluginError("worker_busy", "Too many plugin requests"));
    const id = invocation?.requestId ?? randomUUID();
    if (this.pending.has(id)) return Promise.reject(new HostedPluginError("duplicate_request", "An identical request is still running"));
    const message = { type: "request", id, method, input };
    if (Buffer.byteLength(JSON.stringify(message)) > MAX_HOSTED_MESSAGE_BYTES) return Promise.reject(new HostedPluginError("message_too_large", "Plugin request exceeds limit"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const item = this.pending.get(id);
        if (!item) return;
        item.expired = true; this.unhealthy = true;
        // A timeout is NOT proof that execution or side effects have stopped. Retain its drain lease.
        if (!item.invocation) this.pending.delete(id);
        reject(new HostedPluginError("worker_timeout", "Plugin request timed out; execution outcome may be unknown"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, invocation, expired: false });
      this.child.send(message, error => { if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); if (!this.inFlight) this.events.emit("idle"); } });
    });
  }
  invoke(request: HostedInvocation, timeoutMs = 30_000): Promise<unknown> {
    if (!this.healthy || request.generation !== this.generation) return Promise.reject(new HostedPluginError("stale_generation", "Plugin runtime is not active at this generation"));
    return this.request("invoke", request, timeoutMs, request);
  }
  waitForIdle(timeoutMs = 30_000): Promise<boolean> {
    if (!this.inFlight) return Promise.resolve(true);
    return new Promise(resolve => {
      const idle = () => { clearTimeout(timer); this.events.off("idle", idle); resolve(true); };
      const timer = setTimeout(() => { this.events.off("idle", idle); resolve(false); }, timeoutMs);
      this.events.once("idle", idle);
    });
  }
  async dispose(): Promise<void> {
    if (this.stopped) return;
    if (this.inFlight) throw new HostedPluginError("worker_busy", "Refusing to kill a plugin with in-flight operations");
    if (this.closing) return;
    this.closing = true;
    try { await this.request("dispose", undefined, 2000); } catch { /* No user invocation remains; teardown may be forced. */ }
    if (this.stopped) return;
    await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { this.child.kill("SIGKILL"); }, 1000);
      this.child.once("exit", finish);
      this.child.kill("SIGTERM");
    });
  }
}
