import type { HostedContribution } from "../../../../contracts/hosted-plugins.ts";
import { HostedPluginError } from "./errors.ts";

/** Reviewed, host-owned trust data for one catalog plugin. The package cannot widen it: its tools, UI actions and contribution are fixed here. */
export interface HostedPluginPolicy {
  /** Agent tool name -> runtime action. A package whose descriptors differ is rejected. */
  tools: Readonly<Record<string, string>>;
  /** Actions that tools may mark `readonly`; every other action must not. */
  readonlyActions: readonly string[];
  /** Actions the plugin's own frames may invoke through the host. */
  actions: readonly string[];
  /** Subset of `actions` admitted during a switch barrier (checkpoint synchronization only). */
  checkpointActions: readonly string[];
  contribution: HostedContribution;
}
export const EXCALIDRAW_ID = "@chengzhiyi/pi-excalidraw";
// Reviewed data from package 6328c63, not imported domain code or frontend authorization.
const EXCALIDRAW: HostedPluginPolicy = {
  tools: { excalidraw_read_me: "reference", excalidraw_create_view: "view", diagram_reference: "reference", diagram_create: "create", diagram_read: "read", diagram_patch: "patch" },
  readonlyActions: ["read", "reference"],
  actions: ["list", "new", "open", "import", "get", "focus", "sync", "initialize", "accept", "reject", "save"],
  checkpointActions: ["sync", "get", "list"],
  contribution: {
    entry: { label: "Excalidraw", description: { zh: "手绘图稿", en: "Editable drawings" }, kind: "workspace" },
    panels: ["workspace", "editor"], artifactTools: ["excalidraw_create_view", "diagram_create", "diagram_patch"],
    toolViews: ["excalidraw_create_view", "diagram_create", "diagram_patch"], panelAlias: { prefix: "diagram:", kind: "editor", title: "Excalidraw" },
  },
};
export const GITHUB_PLUGIN_ID = "@chengzhiyi/pi-github";
/** No agent tools: the plugin drives its own background sessions. Its UI may only call the board actions below. */
const GITHUB: HostedPluginPolicy = {
  tools: {}, readonlyActions: [],
  actions: ["get", "configure", "pickup", "sync", "cancel", "approve", "reject", "answer", "remove"],
  checkpointActions: ["get"],
  contribution: {
    entry: { label: "GitHub", description: { zh: "GitHub 任务", en: "GitHub tasks" }, kind: "workspace" },
    panels: ["workspace"], artifactTools: [], toolViews: [], panelAlias: { prefix: "github:", kind: "workspace", title: "GitHub" },
  },
};
/** Policies are inert without a matching catalog entry, so shipping GitHub's here shows no card by itself. */
export const DEFAULT_POLICIES: ReadonlyMap<string, HostedPluginPolicy> = new Map([[EXCALIDRAW_ID, EXCALIDRAW], [GITHUB_PLUGIN_ID, GITHUB]]);

export function policyFor(policies: ReadonlyMap<string, HostedPluginPolicy>, id: string): HostedPluginPolicy {
  const policy = policies.get(id);
  if (!policy) throw new HostedPluginError("unreviewed_plugin", "No trusted tool policy for this package");
  return policy;
}
