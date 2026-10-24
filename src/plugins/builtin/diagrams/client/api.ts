import { accessToken } from "../../../../host/client/access-token.ts";
import { bridgeFetch, bridgeJson } from "../../../../host/client/telemetry-fetch.ts";
export async function stopDiagramGeneration(sessionId: string): Promise<void> {
  await bridgeJson(await bridgeFetch("/api/abort", { method: "POST", headers: { Authorization: `Bearer ${accessToken()}`, "Content-Type": "application/json" }, body: JSON.stringify({ sessionId }) }));
}
export async function diagramAction<T>(sessionId: string, action: string, input: object = {}, signal?: AbortSignal): Promise<T> {
  return bridgeJson(await bridgeFetch(`/api/diagrams/${action}`, { method: "POST", headers: { Authorization: `Bearer ${accessToken()}`, "Content-Type": "application/json" }, body: JSON.stringify({ ...input, sessionId }), signal }));
}
