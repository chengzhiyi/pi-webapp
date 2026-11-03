import { accessToken } from "../../../../host/client/access-token.ts";
import { bridgeFetch, bridgeJson } from "../../../../host/client/telemetry-fetch.ts";
import type { ActivityDetail, ActivitySnapshot, ActivitySource } from "../contract/activity.ts";

async function post<T>(action: string, sessionId: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  return bridgeJson(await bridgeFetch(`/api/activity/${action}`, {
    method: "POST", headers: { Authorization: `Bearer ${accessToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, ...input }), signal,
  }, { expectedNetworkFailure: true }));
}

export const activityApi = {
  snapshot: (sessionId: string, signal?: AbortSignal) => post<ActivitySnapshot>("snapshot", sessionId, {}, signal),
  detail: (sessionId: string, source: ActivitySource, id: string, signal?: AbortSignal) => post<ActivityDetail>("detail", sessionId, { source, id }, signal),
  stop: (sessionId: string, source: ActivitySource, id: string) => post<ActivitySnapshot>("stop", sessionId, { source, id }),
  rerun: (sessionId: string, source: ActivitySource, id: string) => post<ActivitySnapshot>("rerun", sessionId, { source, id }),
};

/** Follows one session-owned NDJSON stream until the caller aborts it. */
export async function followActivity(sessionId: string, signal: AbortSignal, onSnapshot: (snapshot: ActivitySnapshot) => void): Promise<void> {
  const followed = await bridgeFetch("/api/activity/attach", {
    method: "POST", headers: { Authorization: `Bearer ${accessToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId }), signal,
  }, { expectedNetworkFailure: true });
  if (!followed.response.ok) await bridgeJson(followed);
  if (!followed.response.body) throw new Error("Activity stream is unavailable");
  const reader = followed.response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      pending += decoder.decode(value, { stream: true });
      if (pending.length > 2 * 1024 * 1024) throw new Error("Activity stream overflow");
      let end = pending.indexOf("\n");
      while (end >= 0) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (line) {
          try { onSnapshot(JSON.parse(line) as ActivitySnapshot); }
          catch { throw new Error("Invalid activity stream event"); }
        }
        end = pending.indexOf("\n");
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
