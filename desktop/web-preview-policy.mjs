import { isIP } from "node:net";

const explicitWeb = /^https?:\/\/[^/?#]/i;
const scheme = /^[a-z][\w+.-]*:/i;
const hostWithPort = /^[^:/?#\s@]+:\d+(?=[/?#]|$)/u;
const nonWebScheme = /^(?:about|blob|chrome|data|devtools|file|ftp|javascript|mailto|pi-desktop|tel|ws|wss):/i;
const addressPrefix = /^(?:[/\\#[]|[a-z]:[/\\]|[^\s]*:\/\/|https?:|[^:/?#\s]+:\d+(?:\s|[/?#]|$)|[^/\s]+\.[^/\s]+\/)/iu;
const invalidSubmission = value => typeof value !== "string" || value.length > 8192 || /\p{Cc}/u.test(value);
const invalidInput = value => invalidSubmission(value) || value.includes("\\");
const pageProtocols = new Set(["http:", "https:"]);
const networkProtocols = new Set([...pageProtocols, "ws:", "wss:"]);
const defaultPort = url => url.port || (["https:", "wss:"].includes(url.protocol) ? "443" : "80");

function webAddress(value, protocols) {
  if (invalidInput(value)) return null;
  try {
    const url = new URL(value);
    return protocols.has(url.protocol) && !url.username && !url.password ? url : null;
  } catch { return null; }
}

function allowedAddress(value, backendUrl, protocols) {
  const url = webAddress(value, protocols);
  if (!url) return null;
  try {
    // Reserve the backend's port regardless of hostname, including DNS aliases
    // and address spellings Chromium may resolve back to the same service.
    return defaultPort(url) !== defaultPort(new URL(backendUrl)) ? url.href : null;
  } catch { return null; }
}

export function previewAddress(value, backendUrl) {
  return allowedAddress(value, backendUrl, pageProtocols);
}

export function normalizePreviewInput(value) {
  if (typeof value !== "string" || value.length > 8192) return null;
  const input = value.trim();
  if (!input || invalidInput(input)) return null;
  if (explicitWeb.test(input)) return webAddress(input, pageProtocols)?.href ?? null;
  if (/^[/?#]/.test(input) || nonWebScheme.test(input) || (scheme.test(input) && !hostWithPort.test(input))) return null;
  const authority = input.split(/[/?#]/, 1)[0];
  if (authority.includes("@")) return null;
  const url = webAddress(`http://${input}`, pageProtocols);
  if (!url) return null;
  const hostname = url.hostname.replace(/^\[|\]$|\.$/g, "");
  const localStyle = isIP(hostname) || !hostname.includes(".") || /\.(?:localhost|local|test)$/.test(hostname);
  if (localStyle || /:\d+$/.test(authority)) return url.href;
  return webAddress(`https://${input}`, pageProtocols)?.href ?? null;
}

function googleSearch(query) {
  const url = new URL("https://www.google.com/search");
  url.searchParams.set("q", query);
  return url.href;
}

/** Resolve a submitted omnibox value. Malformed URLs never fall through to Google. */
export function resolvePreviewInput(value) {
  if (invalidSubmission(value)) return null;
  const input = value.trim();
  if (!input) return null;
  if (input.startsWith("?")) {
    const query = input.slice(1).trim();
    return query ? googleSearch(query) : null;
  }
  // Multiword queries may contain hostnames (e.g. "react.dev useEffect").
  // Keep URL syntax and possible credentials out of the implicit search fallback.
  if (addressPrefix.test(input) || nonWebScheme.test(input) || input.includes("@")) {
    return normalizePreviewInput(input);
  }
  if (/\s/u.test(input)) return googleSearch(input);
  if (/^localhost(?=$|[:/?#])|[.:/\\]|^[0-9]+(?:\.[0-9]+){0,3}$/iu.test(input)) return normalizePreviewInput(input);
  return googleSearch(input);
}

export function allowPreviewRequest(url, resourceType, backendUrl) {
  // Locally generated subresources needn't use the network. Never allow these as top-level pages.
  if (resourceType !== "mainFrame" && /^(?:data:|blob:|about:blank$)/i.test(url)) return true;
  return Boolean(allowedAddress(url, backendUrl, resourceType === "mainFrame" ? pageProtocols : networkProtocols));
}

export function previewBounds(bounds, viewport, zoom) {
  if (!bounds || !Number.isFinite(zoom) || zoom <= 0) return null;
  const { x, y, width, height } = bounds;
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  const left = Math.max(0, Math.ceil(x * zoom));
  const top = Math.max(0, Math.ceil(y * zoom));
  const right = Math.min(viewport.width, Math.floor((x + width) * zoom));
  const bottom = Math.min(viewport.height, Math.floor((y + height) * zoom));
  return right > left && bottom > top ? { x: left, y: top, width: right - left, height: bottom - top } : null;
}
