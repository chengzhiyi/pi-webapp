import { HostedPluginError } from "./errors.ts";

/** Deliberately small accepted semver grammar. Unknown range syntax fails closed. */
export interface StableVersion { major: number; minor: number; patch: number }
export function stableVersion(value: string): StableVersion | null {
  const m = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!m || m.slice(1).some(n => !Number.isSafeInteger(Number(n)))) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}
export function compareVersions(a: string, b: string): number {
  const x = stableVersion(a), y = stableVersion(b);
  if (!x || !y) throw new HostedPluginError("invalid_version", "Only exact stable semantic versions are supported");
  return x.major - y.major || x.minor - y.minor || x.patch - y.patch;
}
/** Host channels currently published by release-plan: stable and alpha.N only.
 * Plugin archive versions deliberately continue to use stableVersion instead. */
export function hostVersion(value: string): (StableVersion & { alpha?: number }) | null {
  if (typeof value !== "string" || value.length > 128 || value.trim() !== value) return null;
  const m = /^((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?:-alpha\.(0|[1-9]\d*))?$/.exec(value);
  const core = m && stableVersion(m[1]!);
  if (!m || !core || m[2] !== undefined && !Number.isSafeInteger(Number(m[2]))) return null;
  return { ...core, ...(m[2] !== undefined ? { alpha: Number(m[2]) } : {}) };
}
function compareHosts(a: string, b: string): number {
  const x = hostVersion(a)!, y = hostVersion(b)!;
  return x.major - y.major || x.minor - y.minor || x.patch - y.patch
    || (x.alpha === y.alpha ? 0 : x.alpha === undefined ? 1 : y.alpha === undefined ? -1 : x.alpha - y.alpha);
}
export function satisfiesHost(version: string, range: string): boolean {
  const host = hostVersion(version);
  if (!host || typeof range !== "string" || range.length > 256) return false;
  const branches = range.split("||");
  if (!branches.length || branches.some(b => !b.trim())) return false;
  const tests: boolean[] = [];
  for (const branch of branches) {
    const tokens = branch.trim().split(/\s+/);
    let matches = true, admitsAlpha = host.alpha === undefined;
    for (const token of tokens) {
      const m = /^(>=|<=|>|<|=|\^|~)?(.+)$/.exec(token);
      const v = m && hostVersion(m[2]!);
      if (!v) return false;
      const target = m![2]!, c = compareHosts(version, target);
      // Like SemVer prerelease admission, opt-in is local to this OR branch
      // and this exact core tuple; a stable range never silently admits alpha.
      if (v.alpha !== undefined && v.major === host.major && v.minor === host.minor && v.patch === host.patch) admitsAlpha = true;
      switch (m![1] ?? "=") {
        case "=": matches &&= c === 0; break;
        case ">=": matches &&= c >= 0; break;
        case "<=": matches &&= c <= 0; break;
        case ">": matches &&= c > 0; break;
        case "<": matches &&= c < 0; break;
        case "~": matches &&= c >= 0 && compareHosts(version, `${v.major}.${v.minor + 1}.0`) < 0; break;
        case "^": {
          const upper = v.major ? `${v.major + 1}.0.0` : v.minor ? `0.${v.minor + 1}.0` : `0.0.${v.patch + 1}`;
          matches &&= c >= 0 && compareHosts(version, upper) < 0; break;
        }
      }
    }
    tests.push(matches && admitsAlpha);
  }
  return tests.some(Boolean);
}
