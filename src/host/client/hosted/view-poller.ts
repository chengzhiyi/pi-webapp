import type { HostedViewInput, HostedViewReply } from "../../../contracts/hosted-plugins.ts";
import { hostedRequest } from "./api.ts";

type Poll = Extract<HostedViewInput, { operation: "poll" }>;
interface Entry { input(): Poll; accept(reply: HostedViewReply): Promise<void>; fail(error: unknown): void }
interface Result { reply?: HostedViewReply; failure?: { status: number; body: { error: string } } }
/** One short authenticated request per document, not one held HTTP/1.1 socket
 * per iframe. Idle gaps release the origin pool to SSE/assets/actions and other
 * windows. No uncertain writes are retried, and failed readers stop explicitly.
 */
export class HostedViewPoller {
  private entries = new Set<Entry>();
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private interval: number;
  private request: (views: Poll[]) => Promise<{ replies: Result[] }>;
  constructor(interval = 250, request = async (views: Poll[]) => {
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 5000);
    try { return await hostedRequest<{ replies: Result[] }>("/views", { operation: "pollMany", views }, abort.signal); }
    finally { clearTimeout(timeout); }
  }) { this.interval = interval; this.request = request; }
  add(entry: Entry) {
    this.entries.add(entry); this.schedule(0);
    return () => { this.entries.delete(entry); if (!this.entries.size && this.timer) { clearTimeout(this.timer); this.timer = undefined; } };
  }
  private schedule(delay: number) {
    if (this.running || this.timer || !this.entries.size) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.tick(); }, delay);
  }
  private async tick() {
    this.running = true;
    // Fair bounded batches even with many historical thumbnails.
    const entries = [...this.entries];
    try {
      for (let offset = 0; offset < entries.length; offset += 64) {
        const batch = entries.slice(offset, offset + 64).filter(e => this.entries.has(e));
        if (!batch.length) continue;
        const { replies } = await this.request(batch.map(e => e.input()));
        if (!Array.isArray(replies) || replies.length !== batch.length) throw new Error("Invalid aggregate view reply");
        await Promise.all(batch.map(async (entry, i) => {
          if (!this.entries.has(entry)) return;
          try {
            const result = replies[i]!;
            if (result.failure) throw Object.assign(new Error(result.failure.body.error), { status: result.failure.status });
            if (!result.reply || result.reply.viewToken !== entry.input().viewToken) throw new Error("Mismatched view reply");
            await entry.accept(result.reply);
          } catch (error) { this.entries.delete(entry); entry.fail(error); }
        }));
      }
    } catch (error) {
      for (const entry of entries) if (this.entries.delete(entry)) entry.fail(error);
    } finally { this.running = false; this.schedule(this.interval); }
  }
}
export const hostedViewPoller = new HostedViewPoller();
