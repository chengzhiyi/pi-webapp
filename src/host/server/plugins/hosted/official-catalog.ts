import { isHostedPluginManifest } from "@chengzhiyi/pi-web-protocol";
import { HostedPluginError } from "./errors.ts";
import { compareVersions, satisfiesHost, stableVersion } from "./versions.ts";

export interface OfficialPlugin {
  id: string;
  name: string;
  description: { zh: string; en: string };
  registry: string;
  recommendedVersion: string;
  requiredCapabilities: readonly string[];
}
/** Offline metadata only. Never imports the editor or downloads it on first launch. */
export const OFFICIAL_PLUGINS: readonly OfficialPlugin[] = Object.freeze([Object.freeze({
  id: "@chengzhiyi/pi-excalidraw", name: "Excalidraw",
  description: { zh: "本地手绘画布、AI 绘图及工作区图稿。按需安装。", en: "Local sketch canvas, AI diagrams and workspace drawings. Optional download." },
  registry: "https://registry.npmjs.org", recommendedVersion: "0.1.0",
  requiredCapabilities: ["state", "workspace", "legacy", "panels", "messages"],
})]);
export function officialPlugin(id: string, catalog = OFFICIAL_PLUGINS): OfficialPlugin {
  const found = catalog.find(p => p.id === id);
  if (!found) throw new HostedPluginError("unknown_plugin", "Plugin is not in the trusted official catalog");
  return found;
}
export interface RegistryRelease {
  name: string; version: string;
  piWebapp: unknown;
  dist: { tarball: string; integrity: string };
  deprecated?: unknown;
}
export function compatibleRelease(release: RegistryRelease, plugin: OfficialPlugin, hostVersion: string): boolean {
  const manifest = release.piWebapp;
  return release.name === plugin.id && !!stableVersion(release.version) && !release.deprecated
    && isHostedPluginManifest(manifest) && satisfiesHost(hostVersion, manifest.hostRange)
    && plugin.requiredCapabilities.every(c => manifest.capabilities.includes(c));
}
/** No blind latest, prereleases, downgrades, or automatic installation of absent plugins. */
export function selectRelease(metadata: unknown, plugin: OfficialPlugin, hostVersion: string, installedVersion?: string, exact?: string): RegistryRelease {
  if (!metadata || typeof metadata !== "object" || !("versions" in metadata) || !metadata.versions || typeof metadata.versions !== "object" || Array.isArray(metadata.versions)) throw new HostedPluginError("registry_invalid", "Invalid registry version catalog");
  const versions = Object.entries(metadata.versions);
  if (versions.length > 10_000) throw new HostedPluginError("registry_invalid", "Registry version catalog exceeds budget");
  const releases = versions.flatMap(([version, raw]) => {
    if (!raw || typeof raw !== "object") return [];
    const release = raw as RegistryRelease;
    return release.version === version && compatibleRelease(release, plugin, hostVersion) && (!exact || version === exact) && (!installedVersion || compareVersions(version, installedVersion) >= 0) ? [release] : [];
  }).sort((a, b) => compareVersions(b.version, a.version));
  const selected = releases[0];
  if (!selected) throw new HostedPluginError("no_compatible_version", "No compatible stable plugin release is available; installed code and data preserved");
  if (!selected.dist || typeof selected.dist.tarball !== "string" || typeof selected.dist.integrity !== "string") throw new HostedPluginError("registry_invalid", "Release is missing its immutable tarball integrity");
  return selected;
}
export type UpdatePolicy = "notify" | "automatic" | "pinned";
export function hostUpdateDecision(input: { installed: boolean; enabled: boolean; policy: UpdatePolicy; trigger?: "independent" | "host-linked"; currentCompatible: boolean; currentVersion?: string; recommendedVersion?: string; networkAvailable: boolean }): { action: "none" | "keep" | "notify" | "update" | "disable-incompatible"; enabled: boolean } {
  if (!input.installed) return { action: "none", enabled: false };
  if (!input.networkAvailable || input.trigger === "independent" && input.policy === "pinned") return { action: input.currentCompatible ? "keep" : "disable-incompatible", enabled: input.currentCompatible && input.enabled };
  if (!input.recommendedVersion || input.currentVersion && compareVersions(input.currentVersion, input.recommendedVersion) >= 0) return { action: input.currentCompatible ? "keep" : "disable-incompatible", enabled: input.currentCompatible && input.enabled };
  return { action: input.trigger === "independent" && input.policy === "notify" ? "notify" : "update", enabled: input.enabled };
}
