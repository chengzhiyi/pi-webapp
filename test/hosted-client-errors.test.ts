import assert from "node:assert/strict";
import test from "node:test";
import { hostedRequest } from "../src/host/client/hosted/api.ts";

test("hosted HTTP errors preserve flat server code/reason across the frame RPC boundary", async () => {
  const originalFetch = globalThis.fetch;
  const location = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", { configurable: true, value: { hash: "", pathname: "/" } });
  try {
    for (const [status, body, code, reason] of [
      [404, { error: "Historical drawing unavailable", errorCode: "diagram_unavailable", reason: "diagram_unavailable" }, "diagram_unavailable", "diagram_unavailable"],
      [409, { error: "Revision conflict", errorCode: "revision_conflict", reason: "revision_conflict" }, "revision_conflict", "revision_conflict"],
      [403, { error: { message: "Nested wire error", code: "denied", reason: "policy" } }, "denied", "policy"],
    ] as const) {
      globalThis.fetch = async () => new Response(JSON.stringify(body), { status });
      await assert.rejects(hostedRequest("/action", {}), (error: any) => error.status === status && error.code === code && error.reason === reason);
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (location) Object.defineProperty(globalThis, "location", location); else Reflect.deleteProperty(globalThis, "location");
  }
});
