import { HostedPluginError } from "./errors.ts";
import { compareVersions as compareSemanticVersions, isAlphaVersion } from "../../../../../desktop/release-version.mjs";

/** Deliberately small accepted semver grammar. Unknown range syntax fails closed. */
export interface StableVersion { major: number; minor: number; patch: number }
export function stableVersion(value: string): StableVersion | null {
  const m = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!m || m[0] !== value || m.slice(1).some(n => !Number.isSafeInteger(Number(n)))) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}
export function compareVersions(a: string, b: string): number {
  const x = stableVersion(a), y = stableVersion(b);
  if (!x || !y) throw new HostedPluginError("invalid_version", "Only exact stable semantic versions are supported");
  return x.major - y.major || x.minor - y.minor || x.patch - y.patch;
}
/** Host channels are stable or the launcher's exact alpha.N grammar. Plugin versions
 * remain stable-only. Alpha hosts opt into range evaluation with full SemVer
 * precedence: 0.1.31-alpha.5 is NOT 0.1.31 and cannot satisfy >=0.1.31.
 */
export function hostVersion(value: string): (StableVersion & { alpha?: number }) | null {
  const stable = stableVersion(value);
  if (stable) return stable;
  if (!isAlphaVersion(value)) return null;
  const [core, suffix] = value.split("-alpha.");
  const parsed = stableVersion(core!), alpha = Number(suffix);
  return parsed && Number.isSafeInteger(alpha) ? { ...parsed, alpha } : null;
}
export function supportedHostVersion(value: string): boolean {
  return !!hostVersion(value);
}
export function satisfiesHost(version: string, range: string): boolean {
  if (!supportedHostVersion(version) || typeof range !== "string" || range.length > 256) return false;
  const branches = range.split("||");
  if (!branches.length || branches.some(b => !b.trim())) return false;
  const tests: boolean[] = [];
  for (const branch of branches) {
    const tokens = branch.trim().split(/\s+/);
    let matches = true;
    for (const token of tokens) {
      const m = /^(>=|<=|>|<|=|\^|~)?(.+)$/.exec(token);
      const v = m && hostVersion(m[2]!);
      if (!m || !v) return false;
      const target = m[2]!, c = compareSemanticVersions(version, target);
      switch (m[1] ?? "=") {
        case "=": matches &&= c === 0; break;
        case ">=": matches &&= c >= 0; break;
        case "<=": matches &&= c <= 0; break;
        case ">": matches &&= c > 0; break;
        case "<": matches &&= c < 0; break;
        case "~": matches &&= c >= 0 && compareSemanticVersions(version, `${v.major}.${v.minor + 1}.0-0`) < 0; break;
        case "^": {
          const upper = v.major ? `${v.major + 1}.0.0` : v.minor ? `0.${v.minor + 1}.0` : `0.0.${v.patch + 1}`;
          matches &&= c >= 0 && compareSemanticVersions(version, `${upper}-0`) < 0; break;
        }
      }
    }
    tests.push(matches);
  }
  return tests.some(Boolean);
}
