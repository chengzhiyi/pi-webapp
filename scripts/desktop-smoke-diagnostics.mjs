import { open, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Playwright also injects into opaque/error documents. Do not touch storage
// outside the actual loopback UI; storage failures on that UI must still fail.
export function seedSmokeLocale() {
  if (location.protocol === "http:" && location.hostname === "127.0.0.1" && location.pathname === "/") {
    localStorage.setItem("pi-web-locale", "en");
  }
}

export function redactDiagnostic(text, env = {}, additionalSecrets = []) {
  const values = [...Object.entries(env).filter(([key]) => /key|token|secret|password|credential|auth|dsn/i.test(key)).map(([, value]) => value), ...additionalSecrets]
    .filter(value => typeof value === "string").flatMap(value => [value, ...value.split(/\r?\n/)])
    .filter(value => value.length > 0).sort((a, b) => b.length - a.length);
  let result = String(text);
  for (const value of values) result = result.split(value).join("[REDACTED]");
  return result
    .replace(/(https?:\/\/[^\s"'<>#]+)#[^\s"'<>]*/gi, "$1#[REDACTED]")
    .replace(/(https?:\/\/)[^/\s@]+@/gi, "$1[REDACTED]@")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/=_.-]+/gi, "$1 [REDACTED]")
    .replace(/([?&](?:token|key|access_token|auth|api_key)=)[^&\s"'<>]+/gi, "$1[REDACTED]")
    .replace(/(["']?(?:token|nonce|api[_-]?key|authorization)["']?\s*[:=]\s*["']?)[^\s"',}\]]+/gi, "$1[REDACTED]");
}

async function readTail(path, limit = 65536) {
  let file;
  try {
    file = await open(path, "r");
    const { size } = await file.stat();
    const buffer = Buffer.alloc(Math.min(limit, size));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length));
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    // Never retain an incomplete first line containing the tail of a secret.
    return size > buffer.length ? text.slice(text.indexOf("\n") + 1 || text.length) : text;
  } catch { return null; }
  finally { await file?.close(); }
}

/** Only the isolated test backend is read, never real user state/configuration. */
export async function saveSmokeDiagnostics({ artifacts, agentDir, phase, error, stderr = "", env = {} }) {
  let state;
  try { state = JSON.parse(await readFile(join(agentDir, "pi-web/launcher.json"), "utf8")); } catch {}
  const secrets = [state?.nonce];
  try { secrets.push(new URL(state?.url).hash.slice(1)); } catch {}
  const redact = value => redactDiagnostic(value, env, secrets);
  const launcher = state ? Object.fromEntries(["pid", "piPid", "version", "bridgeVersion", "runtimeKind", "status"]
    .filter(key => typeof state[key] === "number" || typeof state[key] === "string")
    .map(key => [key, typeof state[key] === "string" ? redact(state[key]) : state[key]])) : null;
  const log = await readTail(join(agentDir, "pi-web/launcher.log"));
  let stderrTail = stderr.slice(-65536);
  if (stderr.length > 65536) stderrTail = stderrTail.slice(stderrTail.indexOf("\n") + 1 || stderrTail.length);
  const result = { phase, errorType: error.name, message: redact(error.message), launcher,
    backendLog: log === null ? null : redact(log), electronStderr: redact(stderrTail) };
  await writeFile(join(artifacts, "smoke-diagnostics.json"), JSON.stringify(result, null, 2) + "\n");
}
