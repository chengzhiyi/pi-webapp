import { compareVersions, isAlphaVersion, isStableVersion, parseVersion } from "../desktop/release-version.mjs";

/** Repository version is the intended release base; npm tags allocate published numbers. */
export function planRelease(sourceVersion, tags, channel) {
  if (channel !== "stable" && channel !== "alpha") throw new Error("Release channel must be stable or alpha");
  if (!isStableVersion(tags.latest)) throw new Error("npm latest must be a stable version");
  if (!isStableVersion(sourceVersion) && !isAlphaVersion(sourceVersion)) throw new Error("Source version must be stable or alpha");
  const source = parseVersion(sourceVersion).core.join(".");
  const latest = parseVersion(tags.latest).core;
  if (latest[2] === Number.MAX_SAFE_INTEGER) throw new Error("Patch version overflow");
  let base = compareVersions(source, tags.latest) > 0 ? source : `${latest[0]}.${latest[1]}.${latest[2] + 1}`;
  if (channel === "stable") return { version: base, tag: "latest", channel };
  let sequence = 1;
  if (tags.alpha !== undefined) {
    if (!isAlphaVersion(tags.alpha)) throw new Error("npm alpha must be an alpha version");
    const alphaBase = parseVersion(tags.alpha).core.join(".");
    if (compareVersions(alphaBase, base) > 0) base = alphaBase;
    if (alphaBase === base) sequence = Number(tags.alpha.split(".").at(-1)) + 1;
  }
  if (!Number.isSafeInteger(sequence)) throw new Error("Alpha version overflow");
  return { version: `${base}-alpha.${sequence}`, tag: "alpha", channel };
}

/** Desktop bundles the next unreleased base so older npm selections cannot outrank its newer code. */
export function planDesktopVersion(sourceVersion, tags) {
  return parseVersion(planRelease(sourceVersion, tags, "alpha").version).core.join(".");
}

/** A desktop build must never label its bundled backend older than npm latest. */
export function assertDesktopVersionCurrent(version, tags) {
  if (!isStableVersion(tags.latest)) throw new Error("npm latest must be a stable version");
  if (compareVersions(version, tags.latest) < 0)
    throw new Error(`package.json ${version} is older than npm latest ${tags.latest}; run npm run desktop:prepare-build`);
}

export function releaseChannel(ref) {
  if (ref === "refs/heads/main") return "stable";
  if (ref === "refs/heads/alpha") return "alpha";
  throw new Error("Publishing is only allowed from main or alpha");
}
