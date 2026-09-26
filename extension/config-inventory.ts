import { basename, dirname } from "node:path";
import type { ResolvedPaths } from "@earendil-works/pi-coding-agent";

export interface ResourceItem {
  name: string;
  path: string;
  source: string;
  scope: "user" | "project" | "temporary";
  enabled: boolean;
}

interface ConfiguredPackage {
  source: string;
  scope: "user" | "project";
  filtered?: boolean;
  installedPath?: string;
}

export function buildResourceInventory(packages: ConfiguredPackage[], paths: ResolvedPaths): Record<"packages" | "extensions" | "skills", ResourceItem[]> {
  const resources = (kind: "extensions" | "skills") => paths[kind].map((entry) => ({
    name: kind === "skills" && basename(entry.path).toLowerCase() === "skill.md" ? basename(dirname(entry.path)) : basename(entry.path),
    path: entry.path,
    source: entry.metadata.source,
    scope: entry.metadata.scope,
    enabled: entry.enabled,
  }));
  return {
    packages: packages.map((entry) => ({ name: entry.source, path: entry.installedPath ?? "", source: entry.source, scope: entry.scope, enabled: Boolean(entry.installedPath) })),
    extensions: resources("extensions"),
    skills: resources("skills"),
  };
}
