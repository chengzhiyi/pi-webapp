import type { HostedMount, HostedViewIdentity, HostedViewInput, HostedViewReply } from "../../../contracts/hosted-plugins.ts";
import { hostedApi } from "./api.ts";
import { rememberView, forgetView, markViewConnecting } from "./view-journal.ts";
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
  private localCloseCheckpoint = false;
  private frameStarted = false;
  connecting() {
    const recorded = markViewConnecting(this.token);
    if (!recorded && this.mount.kind !== "controller") throw new Error("Cannot protect the editor recovery journal; download local drafts before opening another editor");
    this.frameStarted = true;
  }
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
    this.token = crypto.randomUUID();
    // Persist before network I/O: reload can destroy this document before the
    // registration response arrives. The next document can retire the exact nonce.
    rememberView(this.identity, this.token, this.mount);
    const registered = await hostedApi.view({ ...this.identity, operation: "register", kind: this.mount.kind, viewToken: this.token });
    if (registered.viewToken !== this.token) {
      // Compatibility with an older host that still mints registration tokens.
      forgetView(this.token); this.token = registered.viewToken;
      rememberView(this.identity, this.token, this.mount);
    }
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
    if (this.closed) throw new Error("Closed view cannot reconnect");
    this.unlisten?.(); this.unlisten = undefined;
    this.stopped = false; this.abort = new AbortController();
    if (this.localCloseCheckpoint) {
      // A failed panel close may have frozen a still-live frame outside a server
      // barrier. Restore that exact frame before resuming ordinary polling.
      void this.adapter.call("restore", this.snapshot).then(() => {
        this.frozen = false; this.localCloseCheckpoint = false; this.listen();
      }).catch(this.failed);
    } else this.listen();
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
      if (this.mount.kind !== "controller" && !this.frameStarted) {
        await hostedApi.view({ ...this.identity, viewToken: this.token, operation: "cancel-initialization" });
      } else {
        if (this.mount.kind !== "controller" && !this.frozen) {
          this.snapshot = await this.adapter.call("freeze");
          this.frozen = true;
          this.localCloseCheckpoint = true;
        }
        if (this.localCloseCheckpoint) {
          await hostedApi.view({ ...this.identity, viewToken: this.token, operation: "change", dirty: false, busy: false });
        }
        await hostedApi.view({ ...this.identity, viewToken: this.token, operation: "close" });
      }
      this.closed = true;
      forgetView(this.token);
    })().catch(error => { this.closing = undefined; throw error; });
    return this.closing;
  }
}
