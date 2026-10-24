import type { WebLocalizedText } from "@chengzhiyi/pi-web-protocol";

export interface PluginMetadata {
  id: string;
  name: WebLocalizedText;
  description: WebLocalizedText;
  version: string;
  kind: "builtin" | "external";
}
export interface ManagedPlugin extends PluginMetadata {
  enabled: boolean;
  /** External Pi entry points require an idle resource reload, not just a browser toggle. */
  managed: boolean;
  reason?: string;
}
export interface PluginManagementView { revision: string; items: ManagedPlugin[]; scope: "global" }
export interface PluginToggle { id: string; enabled: boolean; expected: string }
export const BUILTIN_IDS = { diagrams: "@pi-webapp/diagrams", git: "@pi-webapp/git", files: "@pi-webapp/files", terminal: "@pi-webapp/terminal" } as const;
