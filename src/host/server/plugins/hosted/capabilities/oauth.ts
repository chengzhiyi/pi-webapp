import { randomUUID } from "node:crypto";
import { HostedPluginError } from "../errors.ts";

/** How the user can obtain one declared secret in a browser. Host-owned; plugin code never sees any of it. */
export interface SecretAuth {
  /** OAuth App client id (public, device flow enabled). Absent = browser sign-in unavailable. */
  clientId?: string;
  scope: string;
  /** Pre-filled "create a token" page, opened when browser sign-in is unavailable. */
  createUrl: string;
}
const GITHUB_TOKEN_PAGE = "https://github.com/settings/personal-access-tokens/new?" + new URLSearchParams({
  name: "pi-webapp", description: "pi-webapp GitHub plugin", issues: "write", pull_requests: "write", contents: "write",
});
/** Public client id of the pi-webapp GitHub OAuth App (Device Flow enabled; no client secret is used). `PI_WEBAPP_GITHUB_CLIENT_ID` overrides it for forks. */
export const GITHUB_CLIENT_ID = "Ov23limJmKiuu8cOP83E";
export function secretAuthFor(pluginId: string, name: string, env: NodeJS.ProcessEnv = process.env): SecretAuth | undefined {
  if (pluginId === "@chengzhiyi/pi-github" && name === "github-token") return { clientId: env.PI_WEBAPP_GITHUB_CLIENT_ID?.trim() || GITHUB_CLIENT_ID, scope: "repo", createUrl: GITHUB_TOKEN_PAGE };
  return undefined;
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
export type DevicePoll = { status: "pending" | "denied" | "expired" } | { status: "granted"; token: string; pluginId: string; name: string };
interface Flow { pluginId: string; name: string; clientId: string; deviceCode: string; expiresAt: number; interval: number; nextPoll: number }
const DEVICE_URL = "https://github.com/login/device/code", TOKEN_URL = "https://github.com/login/oauth/access_token";
const MAX_FLOWS = 8;

/** GitHub OAuth device flow. Device codes stay in host memory; the browser only gets the short user code. */
export class DeviceFlows {
  private readonly flows = new Map<string, Flow>();
  private readonly fetcher: Fetch;
  private readonly now: () => number;
  constructor(fetcher: Fetch = (url, init) => fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(15_000) }), now: () => number = Date.now) {
    this.fetcher = fetcher;
    this.now = now;
  }
  private async post(url: string, params: Record<string, string>): Promise<Record<string, unknown>> {
    let response;
    try { response = await this.fetcher(url, { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "pi-webapp" }, body: new URLSearchParams(params).toString() }); }
    catch { throw new HostedPluginError("oauth_unreachable", "Cannot reach github.com. Check your network and retry.", { status: 502 }); }
    const value = await response.json().catch(() => null);
    if (!value || typeof value !== "object" || (!response.ok && !("error" in value))) throw new HostedPluginError("oauth_failed", `GitHub sign-in failed (${response.status})`, { status: 502 });
    return value as Record<string, unknown>;
  }
  async start(pluginId: string, name: string, auth: SecretAuth): Promise<{ deviceId: string; userCode: string; verificationUri: string; interval: number; expiresIn: number }> {
    if (!auth.clientId) throw new HostedPluginError("oauth_unavailable", "Browser sign-in is not configured", { status: 503 });
    for (const [id, flow] of this.flows) if (flow.expiresAt <= this.now()) this.flows.delete(id);
    if (this.flows.size >= MAX_FLOWS) throw new HostedPluginError("oauth_busy", "Too many sign-ins in progress", { status: 429 });
    const v = await this.post(DEVICE_URL, { client_id: auth.clientId, scope: auth.scope });
    const { device_code: deviceCode, user_code: userCode, verification_uri: uri } = v;
    const expiresIn = Number(v.expires_in), interval = Math.max(Number(v.interval) || 5, 1);
    if (typeof deviceCode !== "string" || typeof userCode !== "string" || typeof uri !== "string" || !uri.startsWith("https://github.com/") || !Number.isFinite(expiresIn))
      throw new HostedPluginError("oauth_failed", typeof v.error_description === "string" ? v.error_description : "GitHub sign-in could not start. Check that Device Flow is enabled for the OAuth App.", { status: 502 });
    const deviceId = randomUUID();
    this.flows.set(deviceId, { pluginId, name, clientId: auth.clientId, deviceCode, expiresAt: this.now() + expiresIn * 1000, interval, nextPoll: this.now() + interval * 1000 });
    return { deviceId, userCode, verificationUri: uri, interval, expiresIn };
  }
  async poll(deviceId: string): Promise<DevicePoll> {
    const flow = this.flows.get(deviceId);
    if (!flow || flow.expiresAt <= this.now()) { this.flows.delete(deviceId); return { status: "expired" }; }
    if (this.now() < flow.nextPoll) return { status: "pending" };
    flow.nextPoll = this.now() + flow.interval * 1000;
    const v = await this.post(TOKEN_URL, { client_id: flow.clientId, device_code: flow.deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" });
    if (typeof v.access_token === "string" && v.access_token) { this.flows.delete(deviceId); return { status: "granted", token: v.access_token, pluginId: flow.pluginId, name: flow.name }; }
    switch (v.error) {
      case "authorization_pending": return { status: "pending" };
      case "slow_down": flow.interval += 5; flow.nextPoll = this.now() + flow.interval * 1000; return { status: "pending" };
      case "access_denied": this.flows.delete(deviceId); return { status: "denied" };
      default: this.flows.delete(deviceId); return { status: "expired" };
    }
  }
  cancel(deviceId: string) { this.flows.delete(deviceId); }
}
