import type { AgentSession, SessionShutdownEvent } from "@earendil-works/pi-coding-agent";

/** Lifecycle operations serialize without poisoning the queue after a failure. */
export class LifecycleQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => {});
    return result;
  }
  wrap<Args extends unknown[], Result>(operation: (...args: Args) => Promise<Result>): (...args: Args) => Promise<Result> {
    return (...args) => this.run(() => operation(...args));
  }
}

const closing = new WeakMap<AgentSession, Promise<void>>();
/** SDK dispose does not emit shutdown. Always deliver it before invalidating ctx. */
export function closeAgentSession(session: AgentSession, reason: SessionShutdownEvent["reason"], report: (message: string) => void, timeoutMs = 5_000, beforeDispose: () => void = () => {}): Promise<void> {
  const existing = closing.get(session);
  if (existing) return existing;
  const work = (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        session.extensionRunner.emit({ type: "session_shutdown", reason }),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Plugin shutdown timed out")), timeoutMs); }),
      ]);
    } catch (error) { report(error instanceof Error ? error.message : String(error)); }
    finally {
      clearTimeout(timer);
      try { beforeDispose(); } finally { session.dispose(); }
    }
  })();
  closing.set(session, work);
  return work;
}
