import { accessToken } from "../access-token.ts";
import { bridgeFetch } from "../telemetry-fetch.ts";
import type { HostedActionInput, HostedManageInput, HostedPluginCatalog, HostedViewInput, HostedViewReply } from "../../../contracts/hosted-plugins.ts";
export async function hostedRequest<T>(path: string, input?: unknown, signal?: AbortSignal): Promise<T> {
  const token = accessToken();
  const { response } = await bridgeFetch(`/api/hosted-plugins${path}`, { method: input === undefined ? "GET" : "POST", credentials: "same-origin", signal,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(input === undefined ? {} : { "Content-Type": "application/json" }) },
    body: input === undefined ? undefined : JSON.stringify(input) });
  const value = await response.json();
  if (!response.ok) throw Object.assign(new Error(value.error?.message ?? value.error ?? `Hosted plugin request failed (${response.status})`), { status: response.status, code: value.error?.code ?? value.errorCode, reason: value.error?.reason ?? value.reason });
  return value as T;
}
export const hostedApi = {
  catalog: (signal?: AbortSignal) => hostedRequest<HostedPluginCatalog>("", undefined, signal),
  manage: (input: HostedManageInput) => hostedRequest<HostedPluginCatalog>("/manage", input),
  action: (input: HostedActionInput) => hostedRequest<unknown>("/action", input),
  view: (input: HostedViewInput, signal?: AbortSignal) => hostedRequest<HostedViewReply>("/views", input, signal),
};
