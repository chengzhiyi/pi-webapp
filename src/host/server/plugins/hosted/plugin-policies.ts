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
  /** Reviewed browser permissions. `wasm` adds 'wasm-unsafe-eval' to this plugin's served resources only. */
  browser?: { wasm?: boolean };
  /** Reviewed workspace file rules. Absent = the historical `.excalidraw` text rule. */
  workspace?: { files: readonly WorkspaceFileRule[] };
  /** Reviewed per-invocation timeout (default 30 s, max 180 s). */
  runtime?: { invokeTimeoutMs?: number };
}
/** One workspace file kind a plugin may read/commit through the broker. */
export interface WorkspaceFileRule {
  /** Lowercase extension including the dot, e.g. ".fig". */
  extension: string;
  /** Binary rules exchange base64 over JSON IPC; text rules stay strict UTF-8. */
  binary: boolean;
  maxBytes: number;
  /** The single missing first-level directory the broker may create on commit. */
  createDirectory?: string;
}
export const MAX_WORKSPACE_FILE_BYTES = 64 * 1024 * 1024;
/** Exactly the pre-rule behavior: text `.excalidraw`, 512 KiB, may create `diagrams/`. */
export const DEFAULT_WORKSPACE_FILES: readonly WorkspaceFileRule[] = Object.freeze([Object.freeze({ extension: ".excalidraw", binary: false, maxBytes: 512 * 1024, createDirectory: "diagrams" })]);
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
export const PENCIL_ID = "@chengzhiyi/pi-pencil";
/** SPIKE policy (pi-pencil feasibility spike). Reviewed tool set is deliberately small. */
const PENCIL: HostedPluginPolicy = {
  tools: { pencil_read_me: "reference", pencil_status: "status", pencil_inspect: "inspect", pencil_render: "render", pencil_propose_changes: "propose" },
  readonlyActions: ["reference", "status", "inspect", "render"],
  actions: ["list", "get", "accept", "reject", "save", "open", "create", "rename", "selection", "sync", "lock"],
  // A freeze flushes a person's first edits in an empty workspace, which creates their design.
  checkpointActions: ["get", "list", "sync", "create"],
  contribution: {
    entry: { label: "Pencil", description: { zh: "UI 设计", en: "UI design" }, kind: "workspace" },
    panels: ["workspace", "editor"], artifactTools: ["pencil_propose_changes"], toolViews: [], panelAlias: { prefix: "pencil:", kind: "editor", title: "Pencil" },
  },
  browser: { wasm: true },
  workspace: { files: [{ extension: ".fig", binary: true, maxBytes: MAX_WORKSPACE_FILE_BYTES, createDirectory: "designs" }] },
  runtime: { invokeTimeoutMs: 120_000 },
};
/** Policies are inert without a matching catalog entry, so shipping GitHub's here shows no card by itself. */
export const DEFAULT_POLICIES: ReadonlyMap<string, HostedPluginPolicy> = new Map([[EXCALIDRAW_ID, EXCALIDRAW], [GITHUB_PLUGIN_ID, GITHUB], [PENCIL_ID, PENCIL]]);

export function policyFor(policies: ReadonlyMap<string, HostedPluginPolicy>, id: string): HostedPluginPolicy {
  const policy = policies.get(id);
  if (!policy) throw new HostedPluginError("unreviewed_plugin", "No trusted tool policy for this package");
  return policy;
}

/** Workspace rules for a plugin; reviewed policy only. Unknown plugins keep the historical default. */
export function workspaceRulesFor(policies: ReadonlyMap<string, HostedPluginPolicy>, id: string): readonly WorkspaceFileRule[] {
  const rules = policies.get(id)?.workspace?.files ?? DEFAULT_WORKSPACE_FILES;
  for (const rule of rules) {
    if (!/^\.[a-z0-9]{1,16}$/.test(rule.extension) || !Number.isSafeInteger(rule.maxBytes) || rule.maxBytes <= 0 || rule.maxBytes > MAX_WORKSPACE_FILE_BYTES
      || rule.createDirectory !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(rule.createDirectory)) throw new HostedPluginError("invalid_policy", "Invalid workspace file rule");
  }
  return rules;
}
export function invokeTimeoutFor(policies: ReadonlyMap<string, HostedPluginPolicy>, id: string): number | undefined {
  const value = policies.get(id)?.runtime?.invokeTimeoutMs;
  return value === undefined ? undefined : Math.min(Math.max(value, 1_000), 180_000);
}
