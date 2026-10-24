// Shared by publishing, the npm launcher and desktop business-package selection.
// Do not use locale-dependent ordering for SemVer prerelease identifiers.
const pattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function parseVersion(value) {
  const match = typeof value === "string" && pattern.exec(value);
  if (!match || match[0] !== value) throw new Error("版本号无效");
  const core = match.slice(1, 4).map(Number);
  const prerelease = match[4]?.split(".") ?? [];
  if (!core.every(Number.isSafeInteger) || prerelease.some(id => /^\d+$/.test(id) && id.length > 1 && id[0] === "0")) throw new Error("版本号无效");
  return { core, prerelease };
}

export function compareVersions(a, b) {
  const left = parseVersion(a); const right = parseVersion(b);
  for (let i = 0; i < 3; i++) if (left.core[i] !== right.core[i]) return left.core[i] > right.core[i] ? 1 : -1;
  if (!left.prerelease.length || !right.prerelease.length) return Number(!left.prerelease.length) - Number(!right.prerelease.length);
  for (let i = 0; i < Math.max(left.prerelease.length, right.prerelease.length); i++) {
    const x = left.prerelease[i]; const y = right.prerelease[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x); const yn = /^\d+$/.test(y);
    if (xn !== yn) return xn ? -1 : 1;
    if (xn && x.length !== y.length) return x.length > y.length ? 1 : -1;
    return x > y ? 1 : -1;
  }
  return 0;
}

export function isStableVersion(value) {
  try { return parseVersion(value).prerelease.length === 0; } catch { return false; }
}

export function isAlphaVersion(value) {
  try { parseVersion(value); return /^\d+\.\d+\.\d+-alpha\.(0|[1-9]\d*)$/.test(value); } catch { return false; }
}
