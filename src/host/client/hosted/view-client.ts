import type { HostedMount, HostedViewIdentity, HostedViewInput, HostedViewReply } from "../../../contracts/hosted-plugins.ts";
import { hostedApi } from "./api.ts";
import { rememberView, forgetView } from "./view-journal.ts";
import { FrameAdapter } from "./frame-adapter.ts";
import { hostedViewPoller, HostedViewPoller } from "./view-poller.ts";

/** Aggregate read transport; writes and actual frame flush acknowledgements remain per-capability. */
export class HostedViewClient {
  private token = "";
  get capability() { return { viewToken: this.token, mountId: this.identity.mountId }; }
  private stopped = false;
  private closed = false;
  private closing?: Promise<void>;
  private abort = new AbortController();
  private unlisten?: () => void;
  private after = 0;
  private snapshot: unknown;
  private frozen = false;
  private frameStarted = false;
  connecting() { this.frameStarted = true; }
  async flushed() { await this.changed({ dirty: false, busy: false }); }
  private identity: HostedViewIdentity;
  private adapter: FrameAdapter;
  private mount: HostedMount;
  private reconnect: () => void;
  private failed: (error: unknown) => void;
  private poller: HostedViewPoller;
  constructor(identity: HostedViewIdentity, adapter: FrameAdapter, mount: HostedMount, reconnect: () => void, failed: (error: unknown) => void, poller: HostedViewPoller = hostedViewPoller) {
    this.poller = poller; this.identity = identity; this.adapter = adapter; this.mount = mount; this.reconnect = reconnect; this.failed = failed;
  }
  async start() {
    this.token = (await hostedApi.view({ ...this.identity, operation: "register", kind: this.mount.kind })).viewToken;
    rememberView(this.identity, this.token, this.mount);
  }
  listen() {
    if (this.stopped || this.unlisten) return;
    this.unlisten = this.poller.add({
      input: () => ({ ...this.identity, viewToken: this.token, operation: "poll", after: this.after }),
      accept: reply => this.receive(reply), fail: error => { if (!this.stopped) this.failed(error); },
    });
  }
  /** Explicit user retry only: replay pending identity-bound commands, never invent an ack. */
  retry() {
    if (this.stopped) throw new Error("Closed view cannot reconnect");
    this.unlisten?.(); this.unlisten = undefined; this.listen();
  }
  private request(input: Record<string, unknown>) { return hostedApi.view({ ...this.identity, viewToken: this.token, ...input } as HostedViewInput, this.abort.signal); }
  async changed(input: unknown) {
    const status = input as { dirty?: unknown; busy?: unknown };
    if (typeof status?.dirty !== "boolean" || typeof status.busy !== "boolean") throw new Error("Invalid frame status");
    await this.request({ operation: "change", dirty: status.dirty, busy: status.busy });
  }
  private async receive(reply: HostedViewReply) {
    for (const command of reply.commands) {
      if (this.stopped) return;
      let error: unknown;
      try {
        if (command.type === "freeze" && !this.frozen) { this.snapshot = await this.adapter.call("freeze"); this.frozen = true; }
        if (command.type === "resume" && this.frozen) { await this.adapter.call("restore", this.snapshot); this.frozen = false; }
        if (command.type === "committed") {
          await this.request({ operation: "ack", commandId: command.id, ok: true });
          await this.close(); this.reconnect(); return;
        }
      } catch (cause) { error = cause; }
      await this.request({ operation: "ack", commandId: command.id, ok: !error, ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}) });
      this.after = command.id;
      if (error) this.failed(error);
    }
  }
  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.closing) return this.closing;
    this.stopped = true; this.unlisten?.(); this.abort.abort();
    this.closing = (async () => {
      if (!this.token) return;
      // Use independent requests because in-flight status requests were aborted. A frozen view is
      // already checkpointed. Its old-generation capability may CLOSE, but not CHANGE.
      if (!this.frozen) {
        if (this.frameStarted) await this.adapter.call("freeze");
        await hostedApi.view({ ...this.identity, viewToken: this.token, operation: "change", dirty: false, busy: false });
      }
      await hostedApi.view({ ...this.identity, viewToken: this.token, operation: "close" });
      this.closed = true;
      forgetView(this.token);
    })().catch(error => { this.closing = undefined; throw error; });
    return this.closing;
  }
}
