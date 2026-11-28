import type { BridgeEvent } from "../../../contracts/bridge-contract.ts";

// Allow one large snapshot regardless of size; disconnect only when subsequent
// events find too much already queued. Reconnecting starts from a fresh snapshot.
const maxQueuedBytes = 4 * 1024 * 1024;
interface Stream {
  readonly destroyed: boolean;
  readonly writableLength: number;
  once(event: "close", listener: () => void): void;
  write(line: string): void;
  end(line: string): void;
  destroy(): void;
}
const encode = (event: BridgeEvent) => `${JSON.stringify(event)}\n`;

export class EventSubscribers {
  private readonly streams = new Set<Stream>();

  add(stream: Stream, snapshot: Extract<BridgeEvent, { type: "snapshot" }>): void {
    this.streams.add(stream);
    stream.once("close", () => this.streams.delete(stream));
    stream.write(encode(snapshot));
  }

  publish(event: BridgeEvent): void {
    if (!this.streams.size) return;
    const line = encode(event);
    for (const stream of this.streams) if (this.canWrite(stream)) stream.write(line);
  }

  close(reconnect: boolean): void {
    const line = encode({ type: "shutdown", reconnect });
    for (const stream of this.streams) if (this.canWrite(stream)) stream.end(line);
    this.streams.clear();
  }

  private canWrite(stream: Stream): boolean {
    if (!stream.destroyed && stream.writableLength < maxQueuedBytes) return true;
    this.streams.delete(stream);
    if (!stream.destroyed) stream.destroy();
    return false;
  }
}
