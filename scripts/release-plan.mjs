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

export function releaseChannel(ref) {
  if (ref === "refs/heads/main") return "stable";
  if (ref === "refs/heads/alpha") return "alpha";
  throw new Error("Publishing is only allowed from main or alpha");
}
