/** JSON-only browser API. The server resolves cwd/workspace from authenticated session access. */
export interface HostedContribution {
  entry: { label: string; description: { zh: string; en: string }; kind: string };
  panels: string[]; artifactTools: string[]; toolViews: string[];
  panelAlias: { prefix: string; kind: string; title: string };
}
export interface HostedPluginCard {
  pluginId: string; name: string; official: boolean; installed: boolean; enabled: boolean;
  version?: string; availableVersion?: string; pendingVersion?: string; generation?: number;
  phase: string; error?: string; errorCode?: string;
  updatePolicy?: "notify" | "automatic" | "pinned"; pinnedVersion?: string;
  updateDiagnostic?: { hostVersion: string; checkedAt: string; status: "available" | "up-to-date" | "failed"; version?: string; message: string; code?: string };
  /** Manifest-only, integrity-qualified served documents, never arbitrary package paths. */
  documentUrl?: string; controllerUrl?: string; contribution?: HostedContribution;
}
export interface HostedPluginCatalog { plugins: HostedPluginCard[]; offline?: boolean }
export type HostedManageOperation = "install" | "enable" | "disable" | "update" | "uninstall" | "check" | "retry" | "policy" | "cancel-download";
export interface HostedManageInput { pluginId: string; operation: HostedManageOperation; /** Exact client nonce; cancellation cannot target another request. */ downloadId?: string; version?: string; updatePolicy?: "notify" | "automatic" | "pinned"; /** Explicit user-accepted undo-history reset warning. Never set by default. */ reopenEditors?: boolean }
export interface HostedActionInput {
  sessionId: string; pluginId: string; generation: number; action: string; input?: unknown;
  /** Host adapter attaches these, never the iframe. Used ONLY for bounded flush-action admission. */
  viewToken?: string; mountId?: string;
}
export interface HostedMount {
  kind: "controller" | "workspace" | "editor" | "tool"; sessionId: string;
  locale: "zh" | "en"; theme: "light" | "dark"; contentId?: string; visible?: boolean; title?: string;
}
export interface HostedViewIdentity { sessionId: string; pluginId: string; generation: number; mountId: string }
export type HostedViewInput = HostedViewIdentity & (
  | { operation: "register"; kind: HostedMount["kind"] }
  | { operation: "poll"; viewToken: string; after: number; /** Aggregate transport never holds a socket. */ immediate?: boolean }
  | { operation: "change"; viewToken: string; dirty: boolean; busy: boolean }
  | { operation: "ack"; viewToken: string; commandId: number; ok: boolean; error?: string }
  | { operation: "close"; viewToken: string }
  /** Explicit per-capability user decision, not a clean/flush acknowledgement. */
  | { operation: "discard"; viewToken: string; confirmation: "discard-unconfirmed-edits" }
);
export interface HostedViewCommand { id: number; type: "freeze" | "resume" | "committed"; generation: number }
export interface HostedViewReply { viewToken: string; commands: HostedViewCommand[] }
export const OFFICIAL_HOSTED_PLUGIN: HostedPluginCard = {
  pluginId: "@chengzhiyi/pi-excalidraw", name: "Excalidraw", official: true,
  installed: false, enabled: false, phase: "not-installed",
};
