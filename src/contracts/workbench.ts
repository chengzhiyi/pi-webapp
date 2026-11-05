import type { ReactNode, ComponentType } from "react";
import type { WebPluginDefinition, WebLocalizedText, WebSlotProps } from "@chengzhiyi/pi-web-protocol";
import type { SessionView, ViewBlock, ViewMessage } from "./bridge-contract.ts";

export interface ToolViewProps extends WebSlotProps { call: ViewBlock; result?: ViewMessage; running: boolean }
export interface TabResource { value: unknown; dispose?(): void; activate?(active: boolean): void }
export interface WorkbenchPanelProps {
  session: SessionView;
  locale: "zh" | "en";
  visible: boolean;
  contentId: string;
  title: string;
  renderMarkdown(text: string, pathImages?: { resolve(value: string): string | undefined }): ReactNode;
  open(kind: string, contentId: string, title: string): void;
  sendMessage(text: string): Promise<void>;
  resource<T>(create: () => T, dispose?: (value: T) => void, activate?: (value: T, active: boolean) => void): T;
  /**
   * Describe what this tab currently shows, for prompts addressed to it from the floating composer.
   * `detail` is shown to the user ("package.json · L55–80"); `reference` is what the agent reads.
   * Call again when it changes; null clears it. The host adds the tab's title and kind itself.
   */
  reportContext?(context: TabContextReport | null): void;
}
export interface TabContextReport { detail?: string; reference?: string }
export interface WorkbenchPanelContribution {
  kind: string;
  component: ComponentType<WorkbenchPanelProps>;
  title?: (contentId: string, fallback: string) => ReactNode;
}
/** Additive host contribution. Existing protocol-v1 slots/actions remain valid for external packages. */
export interface WorkbenchPluginDefinition extends WebPluginDefinition {
  workbench?: {
    apiVersion: 1;
    /** History-only renderers may omit a launcher. */
    entry?: { label: WebLocalizedText; panelTitle?: WebLocalizedText; description: WebLocalizedText; kind: string; multiple?: boolean; icon: ComponentType<{ size?: number }> };
    panels: readonly WorkbenchPanelContribution[];
    /** Native tool-result UI, also receives partial arguments while the model streams. Not an MCP Apps bridge. */
    toolViews?: readonly { tools: readonly string[]; component: ComponentType<ToolViewProps> }[];
    /** Synchronize user-edited plugin state before a main-conversation prompt is sent. */
    beforeSend?(sessionId: string): Promise<void>;
    /** Resolve a plugin-owned artifact link into a typed, owned workbench tab. */
    resolvePanel?(panelId: string): { kind: string; contentId: string; title: string } | null;
  };
}
