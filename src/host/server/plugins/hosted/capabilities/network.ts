import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { HostedPluginError } from "../errors.ts";
import type { SecretStore } from "./secrets.ts";

export interface NetworkRequest { url: string; method?: string; headers?: Record<string, string>; body?: string; secret?: string }
export interface NetworkResponse { status: number; headers: Record<string, string>; body: string }
export interface NetworkDeps {
  secrets: SecretStore;
  fetch?: typeof fetch;
  /** Resolves a hostname to all addresses; injected for tests. */
  resolve?(host: string): Promise<string[]>;
  timeoutMs?: number;
  maxResponseBytes?: number;
}
const METHODS = new Set(["GET", "POST", "PATCH", "PUT", "DELETE"]);
const FORBIDDEN_REQUEST_HEADERS = new Set(["authorization", "cookie", "host", "proxy-authorization", "connection", "content-length", "transfer-encoding"]);
const EXPOSED_RESPONSE_HEADERS = new Set(["content-type", "etag", "link", "location", "retry-after", "x-ratelimit-remaining", "x-ratelimit-reset", "x-github-request-id"]);
const deny = (message: string, reason: string): never => { throw new HostedPluginError("network_denied", message, { status: 403, reason }); };

export function privateAddress(address: string): boolean {
  const a = address.toLowerCase().replace(/^::ffff:/, "");
  if (isIP(a) === 4) {
    const [x, y] = a.split(".").map(Number) as [number, number];
    return x === 0 || x === 10 || x === 127 || x === 169 && y === 254 || x === 172 && y >= 16 && y <= 31 || x === 192 && y === 168 || x === 100 && y >= 64 && y <= 127 || x >= 224;
  }
  return a === "::" || a === "::1" || a.startsWith("fc") || a.startsWith("fd") || /^fe[89ab]/.test(a) || a.startsWith("ff");
}
/** Host-side egress for plugins. The plugin process never holds the secret, only names it. */
export async function pluginFetch(pluginId: string, allowedHosts: readonly string[], declaredSecrets: readonly string[], request: unknown, deps: NetworkDeps): Promise<NetworkResponse> {
  const r = request as NetworkRequest | null;
  if (!r || typeof r !== "object" || typeof r.url !== "string") throw new HostedPluginError("invalid_input", "Invalid network request");
  let url: URL;
  try { url = new URL(r.url); } catch { throw new HostedPluginError("invalid_input", "Invalid URL"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port && url.port !== "443") deny("Only plain https on port 443 is allowed", "scheme");
  if (!allowedHosts.includes(url.hostname)) deny("Host is not declared by the plugin", "host");
  const method = (r.method ?? "GET").toUpperCase();
  if (!METHODS.has(method)) throw new HostedPluginError("invalid_input", "Unsupported method");
  if (r.body !== undefined && (typeof r.body !== "string" || r.body.length > 1024 * 1024)) throw new HostedPluginError("invalid_input", "Invalid body");
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.headers ?? {})) {
    if (typeof v !== "string" || FORBIDDEN_REQUEST_HEADERS.has(k.toLowerCase()) || !/^[\w-]{1,64}$/.test(k) || /[\r\n]/.test(v)) throw new HostedPluginError("invalid_input", `Header not allowed: ${k.slice(0, 64)}`);
    headers[k] = v;
  }
  let token: string | null = null;
  if (r.secret !== undefined) {
    if (!declaredSecrets.includes(r.secret)) deny("Secret is not declared by the plugin", "secret");
    token = await deps.secrets.get(pluginId, r.secret);
    if (!token) throw new HostedPluginError("secret_missing", "Secret has not been configured", { status: 412 });
    headers.Authorization = `Bearer ${token}`;
  }
  const addresses = await (deps.resolve ?? (async h => (await lookup(h, { all: true })).map(x => x.address)))(url.hostname);
  if (!addresses.length || addresses.some(privateAddress)) deny("Host resolves to a non-public address", "address");
  const timeoutMs = deps.timeoutMs ?? 20_000, max = deps.maxResponseBytes ?? 2 * 1024 * 1024;
  const response = await (deps.fetch ?? fetch)(url, { method, headers, body: r.body, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
  const chunks: Buffer[] = []; let size = 0;
  if (response.body) for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > max) throw new HostedPluginError("response_too_large", "Network response exceeds limit", { status: 502 });
    chunks.push(Buffer.from(chunk));
  }
  let body = Buffer.concat(chunks).toString("utf8");
  const out: Record<string, string> = {};
  response.headers.forEach((v, k) => { if (EXPOSED_RESPONSE_HEADERS.has(k.toLowerCase())) out[k.toLowerCase()] = v; });
  if (token) body = body.split(token).join("[redacted]");
  return { status: response.status, headers: out, body };
}
