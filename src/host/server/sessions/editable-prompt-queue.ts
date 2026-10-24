import { randomUUID } from "node:crypto";
import type { QueuedPrompt, QueuedPromptAction } from "../../../contracts/bridge-contract.ts";
import type { ErrorCorrelation } from "../../../contracts/telemetry.ts";
import { displayUserMessage } from "../../../contracts/user-message.ts";

export type PromptImages = Array<{ type: "image"; data: string; mimeType: string }>;
interface Entry { id: string; revision: number; text: string; images: PromptImages; status: "queued" | "sending"; correlation?: ErrorCorrelation; error?: string }
type Deliver = (text: string, images: PromptImages, correlation?: ErrorCorrelation) => Promise<void>;
const bytes = (value: { text: string; images: PromptImages }) => Buffer.byteLength(value.text) + value.images.reduce((sum, image) => sum + image.data.length, 0);
export class PromptQueueError extends Error { readonly status = 409; }

/** The sole owner of web follow-ups until admission. Never rewrites Pi's queues. */
export class EditablePromptQueue {
  private entries: Entry[] = [];
  private pumping = false;
  private readonly changed: () => void;
  constructor(changed: () => void = () => {}) { this.changed = changed; }
  get length(): number { return this.entries.length; }
  get sending(): boolean { return this.entries.some(entry => entry.status === "sending"); }
  view(): QueuedPrompt[] {
    return this.entries.map(entry => ({ id: entry.id, revision: entry.revision, ...displayUserMessage(entry.text), status: entry.status, ...(entry.error ? { error: entry.error } : {}) }));
  }
  enqueue(text: string, images: PromptImages = [], correlation?: ErrorCorrelation): void {
    this.validateText(text);
    if (this.entries.length >= 50 || this.entries.reduce((sum, entry) => sum + bytes(entry), bytes({ text, images })) > 64 * 1024 * 1024) throw new PromptQueueError("待处理提示词过多，请先处理现有队列");
    this.entries.push({ id: randomUUID(), revision: 1, text, images: images.map(image => ({ ...image })), correlation, status: "queued" });
    this.changed();
  }
  private validateText(text: string): void {
    if (!text.trim() || text.length > 32_000 || text.trimStart().startsWith("/")) throw new PromptQueueError("追加提示词无效、过长或包含斜杠指令");
  }
  private find(id: string, revision: number): Entry {
    const entry = this.entries.find(item => item.id === id);
    if (!entry || entry.revision !== revision) throw new PromptQueueError("队列项已变化或已发送，请使用最新状态重试");
    if (entry.status !== "queued") throw new PromptQueueError("提示词正在发送，无法修改");
    return entry;
  }
  async update(id: string, revision: number, action: QueuedPromptAction, deliver: Deliver): Promise<void> {
    const entry = this.find(id, revision);
    if (action.kind === "remove") { this.entries = this.entries.filter(item => item !== entry); this.changed(); return; }
    if (action.kind === "edit") {
      const visible = displayUserMessage(entry.text);
      const suffix = entry.text.slice(visible.text.length).replace(/^\n\n/u, "");
      const text = [action.text.trim(), suffix].filter(Boolean).join("\n\n");
      this.validateText(text);
      if (this.entries.reduce((sum, current) => sum + bytes(current), 0) - bytes(entry) + bytes({ text, images: entry.images }) > 64 * 1024 * 1024) throw new PromptQueueError("待处理提示词过多，请先处理现有队列");
      entry.text = text; entry.revision++; delete entry.error;
      this.changed(); return;
    }
    await this.deliver(entry, deliver);
  }
  private async deliver(entry: Entry, send: Deliver): Promise<void> {
    entry.status = "sending"; entry.revision++; delete entry.error; this.changed();
    try {
      await send(entry.text, entry.images, entry.correlation);
      this.entries = this.entries.filter(item => item !== entry);
    } catch (cause) {
      entry.status = "queued"; entry.revision++;
      entry.error = cause instanceof Error ? cause.message : "发送失败";
      throw cause;
    } finally { this.changed(); }
  }
  /** Only called after a settled run. Yield beyond Pi's notification-only handler. */
  schedule(ready: () => boolean, send: Deliver): void {
    const first = this.entries[0];
    if (this.pumping || !first || first.status !== "queued" || first.error || !ready()) return;
    this.pumping = true;
    // Reserve now so a busy->idle snapshot cannot admit a competing run.
    first.status = "sending"; first.revision++; this.changed();
    setImmediate(() => {
      void (async () => {
        try {
          if (!ready()) { first.status = "queued"; first.revision++; this.changed(); return; }
          await this.deliver(first, send);
        } catch { /* Keep the row and error; an uncertain send is never replayed. */ }
        finally {
          this.pumping = false;
          // Fast/local providers may have settled before preflight resolves.
          if (ready()) this.schedule(ready, send);
        }
      })();
    });
  }
}
