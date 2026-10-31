import { readFile, rename, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const launcherHandoffProtocol = 1;
export const handoffPath = agentDir => join(agentDir, "pi-web", "launcher-handoff.json");
export function validHandoff(value) {
  return value?.protocol === launcherHandoffProtocol && typeof value.nonce === "string" && value.nonce.length > 0
    && /^[a-f0-9-]{36}$/i.test(value.requestId) && Number.isSafeInteger(value.pid) && value.pid > 0
    && ["requested", "draining", "stopped", "refused", "failed"].includes(value.phase);
}
export async function readHandoff(agentDir) {
  try {
    const value = JSON.parse(await readFile(handoffPath(agentDir), "utf8"));
    if (!validHandoff(value)) throw new Error("Invalid launcher handoff journal; original data retained");
    return value;
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
async function atomicRecord(target, value) {
  const temporary = `${target}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify(value), { mode: 0o600 }); await rename(temporary, target); }
  finally { await unlink(temporary).catch(() => {}); }
}

export async function writeHandoff(agentDir, value) {
  if (!validHandoff(value)) throw new Error("Invalid launcher handoff receipt");
  await atomicRecord(handoffPath(agentDir), value);
}
export function validHandoffIntent(value) {
  return validHandoff(value) && value.phase === "requested" && typeof value.version === "string"
    && typeof value.url === "string" && value.url.length < 500
    && (value.completed === undefined || value.completed === true)
    && (value.cancelled === undefined || value.cancelled === true) && !(value.completed && value.cancelled);
}
export async function readHandoffIntent(agentDir) {
  try {
    const value = JSON.parse(await readFile(join(agentDir, "pi-web", "desktop-handoff.json"), "utf8"));
    if (!validHandoffIntent(value)) throw new Error("Invalid desktop handoff intent; original data retained");
    return value;
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
export async function writeHandoffIntent(agentDir, value) {
  if (!validHandoffIntent(value)) throw new Error("Invalid desktop handoff intent");
  await atomicRecord(join(agentDir, "pi-web", "desktop-handoff.json"), value);
}
