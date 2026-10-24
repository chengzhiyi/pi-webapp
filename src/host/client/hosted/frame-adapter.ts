import type { HostedMount, HostedViewIdentity } from "../../../contracts/hosted-plugins.ts";

interface Response { type: "response"; id: string; ok: boolean; value?: unknown; error?: { code: string; message: string; status?: number; reason?: string } }
export type FrameHostCall = (method: string, input: unknown) => Promise<unknown>;
/** A private MessagePort is tied to one exact iframe Window, URL origin, mount and generation. */
export class FrameAdapter {
  private port: MessagePort | null = null;
  private pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private sequence = 0;
  private disposed = false;
  private connection = 0;
  readonly frame: HTMLIFrameElement;
  readonly identity: HostedViewIdentity;
  private host: FrameHostCall;
  private timeoutMs: number;
  constructor(frame: HTMLIFrameElement, identity: HostedViewIdentity, host: FrameHostCall, timeoutMs = 10_000) {
    this.frame = frame; this.identity = identity; this.host = host; this.timeoutMs = timeoutMs;
  }
  async connect(url: string, mount: HostedMount): Promise<void> {
    if (this.disposed || this.port) throw new Error("Frame already connected or disposed");
    const target = new URL(url, location.href);
    if (!["http:", "https:"].includes(target.protocol) || target.username || target.password) throw new Error("Invalid frame document URL");
    target.searchParams.set("parentOrigin", location.origin);
    for (const key of ["pluginId", "generation", "mountId"] as const) target.searchParams.set(key, String(this.identity[key]));
    const connection = ++this.connection;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error("Frame document timed out")), this.timeoutMs);
      const finish = (error?: Error) => { clearTimeout(timer); this.frame.removeEventListener("load", load); this.frame.removeEventListener("error", failed); this.cancelLoad = null; error ? reject(error) : resolve(); };
      const failed = () => finish(new Error("Frame document failed"));
      const load = () => finish();
      this.cancelLoad = () => finish(new Error("Frame disposed"));
      this.frame.addEventListener("load", load, { once: true }); this.frame.addEventListener("error", failed, { once: true });
      this.frame.src = target.href;
    });
    if (this.disposed || connection !== this.connection || !this.frame.contentWindow) throw new Error("Frame connection superseded");
    const source = this.frame.contentWindow;
    const channel = new MessageChannel(); this.port = channel.port1;
    this.port.onmessage = event => { if (!this.disposed && this.frame.contentWindow === source && connection === this.connection) void this.receive(event.data); };
    this.port.onmessageerror = () => this.dispose(); this.port.start();
    source.postMessage({ type: "pi:hosted:connect", protocol: 1, pluginId: this.identity.pluginId, generation: this.identity.generation, mountId: this.identity.mountId }, target.origin, [channel.port2]);
    // A navigation after the handshake cannot reuse this capability.
    this.frame.addEventListener("load", this.navigated);
    await this.call("initialize", mount);
  }
  private cancelLoad: (() => void) | null = null;
  private navigated = () => this.dispose();
  private async receive(data: unknown) {
    if (!data || typeof data !== "object") return;
    const message = data as Response & { method?: string; input?: unknown };
    if (typeof message.id !== "string") return;
    if (message.type === "response") {
      const pending = this.pending.get(message.id); if (!pending) return;
      this.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.ok === true) pending.resolve(message.value);
      else pending.reject(Object.assign(new Error(message.error?.message ?? "Frame RPC failed"), message.error));
    } else if ((message as { type: string }).type === "request" && typeof message.method === "string") {
      try { const value = await this.host(message.method, message.input); this.port?.postMessage({ type: "response", id: message.id, ok: true, value }); }
      catch (cause) {
        const error = cause as Error & { code?: string; status?: number; reason?: string };
        this.port?.postMessage({ type: "response", id: message.id, ok: false, error: { code: error.code ?? "host_error", message: error.message ?? String(cause), status: error.status, reason: error.reason } });
      }
    }
  }
  call(method: string, input?: unknown): Promise<unknown> {
    if (this.disposed || !this.port) return Promise.reject(new Error("Frame is not connected"));
    const id = `${this.identity.mountId}:${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Frame ${method} timed out; edits were not acknowledged`)); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.port!.postMessage({ type: "request", id, method, input }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  dispose() {
    if (this.disposed) return; this.disposed = true; ++this.connection;
    this.cancelLoad?.(); this.frame.removeEventListener("load", this.navigated);
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error("Frame disposed")); }
    this.pending.clear(); this.port?.close(); this.port = null;
  }
}

/** No controller-only shortcut: hidden editors and all streaming tool frames participate. */
export class FrameRegistry {
  private frames = new Set<{ identity: HostedViewIdentity; ready: Promise<unknown>; adapter: FrameAdapter; afterFlush?(): Promise<void> }>();
  add(item: { identity: HostedViewIdentity; ready: Promise<unknown>; adapter: FrameAdapter; afterFlush?(): Promise<void> }) { this.frames.add(item); return () => this.frames.delete(item); }
  async flush(sessionId: string) {
    const frames = [...this.frames].filter(frame => frame.identity.sessionId === sessionId);
    const results = await Promise.allSettled(frames.map(async frame => { await frame.ready; await frame.adapter.call("flush"); await frame.afterFlush?.(); }));
    const failed = results.find(result => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    if (frames.length !== [...this.frames].filter(frame => frame.identity.sessionId === sessionId).length || frames.some(frame => !this.frames.has(frame))) throw new Error("Plugin views changed during flush; retry without losing your prompt");
  }
}
export const hostedFrames = new FrameRegistry();
