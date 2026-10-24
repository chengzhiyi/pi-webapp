import type { HostedMount, HostedViewIdentity, HostedViewInput } from "../../../contracts/hosted-plugins.ts";
import { hostedApi } from "./api.ts";
import { FrameAdapter } from "./frame-adapter.ts";

/** One bounded long-poll at a time. Network failure stops polling; no implicit retry of uncertain writes. */
export class HostedViewClient {
  private token = "";
  get capability() { return { viewToken: this.token, mountId: this.identity.mountId }; }
  private stopped = false;
  private abort = new AbortController();
  private snapshot: unknown;
  private frozen = false;
  private safeToClose = false;
  private frameStarted = false;
  connecting() { this.frameStarted = true; }
  async flushed() { await this.changed({ dirty: false, busy: false }); this.safeToClose = true; }
  constructor(private identity: HostedViewIdentity, private adapter: FrameAdapter, private mount: HostedMount, private reconnect: () => void, private failed: (error: unknown) => void) {}
  async start() {
    this.token = (await hostedApi.view({ ...this.identity, operation: "register", kind: this.mount.kind })).viewToken;
  }
  listen() { void this.poll().catch(error => { if (!this.stopped) this.failed(error); }); }
  private request(input: Record<string, unknown>) { return hostedApi.view({ ...this.identity, viewToken: this.token, ...input } as HostedViewInput, this.abort.signal); }
  async changed(input: unknown) {
    const status = input as { dirty?: unknown; busy?: unknown };
    if (typeof status?.dirty !== "boolean" || typeof status.busy !== "boolean") throw new Error("Invalid frame status");
    if (status.dirty || status.busy) this.safeToClose = false;
    await this.request({ operation: "change", dirty: status.dirty, busy: status.busy });
  }
  private async poll() {
    let after = 0;
    while (!this.stopped) {
      const reply = await this.request({ operation: "poll", after });
      for (const command of reply.commands) {
        let error: unknown;
        try {
          if (command.type === "freeze") { this.snapshot = await this.adapter.call("freeze"); this.frozen = true; }
          if (command.type === "resume" && this.frozen) { await this.adapter.call("restore", this.snapshot); this.frozen = false; }
          if (command.type === "committed") {
            await this.request({ operation: "ack", commandId: command.id, ok: true });
            await this.request({ operation: "close" }); this.stopped = true; this.reconnect(); return;
          }
        } catch (cause) { error = cause; }
        await this.request({ operation: "ack", commandId: command.id, ok: !error, ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}) });
        after = command.id;
        if (error) this.failed(error);
      }
    }
  }
  async close() {
    this.stopped = true; this.abort.abort();
    if (!this.token) return;
    // Use an independent request because the long poll has been aborted.
    if (!this.frozen && this.frameStarted && !this.safeToClose) await this.adapter.call("flush");
    await hostedApi.view({ ...this.identity, viewToken: this.token, operation: "change", dirty: false, busy: false });
    await hostedApi.view({ ...this.identity, viewToken: this.token, operation: "close" });
  }
}
