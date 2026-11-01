import { HostedPluginError } from "../errors.ts";

export interface ScheduleDeclaration { id: string; intervalSec: number; action: string }
export interface CapabilityDeclarations {
  secrets: readonly string[];
  networkHosts: readonly string[];
  schedules: readonly ScheduleDeclaration[];
  sessions: boolean;
}
export const MIN_SCHEDULE_SEC = 30;
const NAME = /^[a-z][a-z0-9-]{0,63}$/;
const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const bad = (message: string): never => { throw new HostedPluginError("invalid_package", message); };
const array = (value: unknown, what: string): unknown[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) return bad(`Invalid ${what} declaration`);
  return value;
};
/** Capability use needs both the capability string and a concrete declaration. Anything undeclared stays denied. */
export function parseDeclarations(manifest: unknown): CapabilityDeclarations {
  const m = (manifest && typeof manifest === "object" ? manifest : {}) as Record<string, unknown>;
  const caps = new Set(Array.isArray(m.capabilities) ? m.capabilities.filter((c): c is string => typeof c === "string") : []);
  const secrets = caps.has("secrets") ? array(m.secrets, "secrets").map(item => {
    const name = (item as { name?: unknown } | null)?.name;
    return typeof name === "string" && NAME.test(name) ? name : bad("Invalid secret name");
  }) : [];
  const net = m.network as { hosts?: unknown } | undefined;
  const networkHosts = caps.has("network") ? array(net?.hosts, "network").map(h => typeof h === "string" && HOST.test(h) ? h : bad("Network hosts must be exact lowercase DNS names")) : [];
  const schedules = caps.has("scheduler") ? array(m.schedules, "schedules").map(item => {
    const s = item as Partial<ScheduleDeclaration> | null;
    if (!s || typeof s.id !== "string" || !NAME.test(s.id) || typeof s.action !== "string" || !/^[\w.-]{1,80}$/.test(s.action)
      || !Number.isSafeInteger(s.intervalSec) || s.intervalSec! < MIN_SCHEDULE_SEC || s.intervalSec! > 86_400) return bad("Invalid schedule declaration");
    return { id: s.id, intervalSec: s.intervalSec!, action: s.action };
  }) : [];
  if (new Set(schedules.map(s => s.id)).size !== schedules.length) bad("Duplicate schedule id");
  return { secrets, networkHosts, schedules, sessions: caps.has("sessions") };
}
