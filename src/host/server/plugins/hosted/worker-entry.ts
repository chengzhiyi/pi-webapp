/** Build as a standalone Node ESM entry. No host API token or ExtensionContext enters this process. */
import { AsyncLocalStorage } from "node:async_hooks";
import { pathToFileURL } from "node:url";
import type { CreateHostedRuntime, HostedInvocation, HostedRuntime } from "@chengzhiyi/pi-web-protocol";
import { failure } from "./errors.ts";

const scope = new AsyncLocalStorage<HostedInvocation>();
const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
let counter = 0, runtime: HostedRuntime | undefined;
const send = (message: unknown) => { if (process.connected) process.send?.(message); };
process.on("message", (raw: unknown) => {
  if (!raw || typeof raw !== "object") return;
  const m = raw as Record<string, unknown>;
  if (m.type === "broker-response" && typeof m.id === "string") {
    const item = pending.get(m.id);
    if (!item) return;
    pending.delete(m.id);
    if (m.ok) item.resolve(m.value); else {
      const error = m.error as { code?: string; message?: string; status?: number; reason?: string } | undefined;
      item.reject(Object.assign(new Error(error?.message ?? "Host broker rejected request"), { code: error?.code, status: error?.status, reason: error?.reason }));
    }
    return;
  }
  if (m.type !== "request" || typeof m.id !== "string" || typeof m.method !== "string") return;
  const id = m.id;
  void (async () => {
    switch (m.method) {
      case "initialize": {
        if (runtime) throw new Error("Already initialized");
        const input = m.input as { entry: string; pluginId: string; version: string; generation: number };
        const module = await import(pathToFileURL(input.entry).href) as { createRuntime?: CreateHostedRuntime };
        if (typeof module.createRuntime !== "function") throw new Error("Missing createRuntime export");
        runtime = await module.createRuntime({ pluginId: input.pluginId, version: input.version, generation: input.generation, broker: {
          call(method, input) {
            const invocation = scope.getStore();
            if (!invocation) return Promise.reject(new Error("Broker calls require an active invocation"));
            if (pending.size >= 64) return Promise.reject(new Error("Too many broker requests"));
            const requestId = `b${++counter}`;
            return new Promise((resolve, reject) => {
              pending.set(requestId, { resolve, reject });
              send({ type: "broker-request", id: requestId, invocationId: invocation.requestId, method, input });
            });
          },
        } });
        return { initialized: true };
      }
      case "describe": if (!runtime) throw new Error("Not initialized"); return runtime.describe();
      case "health": if (!runtime) throw new Error("Not initialized"); return runtime.health();
      case "invoke": {
        if (!runtime) throw new Error("Not initialized");
        const invocation = m.input as HostedInvocation;
        return scope.run(invocation, () => runtime!.invoke(invocation));
      }
      case "dispose": await runtime?.dispose?.(); return { disposed: true };
      default: throw new Error("Unknown runtime operation");
    }
  })().then(value => send({ type: "response", id, ok: true, value }), error => send({ type: "response", id, ok: false, error: failure(error) }));
});
process.on("disconnect", () => {
  for (const value of pending.values()) value.reject(new Error("Host disconnected"));
  pending.clear();
  // The host may have died while a write was in flight. OS teardown is not a successful drain.
  process.exitCode = 1;
  void Promise.resolve(runtime?.dispose?.()).finally(() => process.exit(1));
});
