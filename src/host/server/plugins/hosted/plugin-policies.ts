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
  /** Reviewed browser sign-in for secrets the package declares. Absent = the user pastes the value. */
  secrets?: Readonly<Record<string, SecretAuthPolicy>>;
}
/** How the host helps the user obtain one secret. Only GitHub's OAuth device flow is implemented. */
export interface SecretAuthPolicy {
  provider: "github";
  /** OAuth scope requested by the device flow. */
  scope: string;
  /** Pre-filled "create a token" page, opened when browser sign-in is unavailable. */
  createUrl: string;
  /** Public OAuth App client id (device flow, no secret). Absent = the host's own pi-webapp OAuth App. */
  clientId?: string;
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
