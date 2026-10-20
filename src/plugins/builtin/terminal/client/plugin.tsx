import { defineWebPlugin } from "@chengzhiyi/pi-web-protocol";
import type { WorkbenchPluginDefinition } from "../../../../contracts/workbench.ts";
import { metadata } from "../contract/manifest.ts";
import { TerminalSession } from "./terminal-session.ts";
import { WorkspaceTerminal } from "./WorkspaceTerminal.tsx";
import { randomUUID } from "../../../../host/client/random-uuid.ts";

export default defineWebPlugin<WorkbenchPluginDefinition>({
  id: metadata.id, apiVersion: 1, activate() {},
  workbench: {
    apiVersion: 1,
    entry: { label: { zh: "打开终端", en: "Open terminal" }, panelTitle: metadata.name, description: { zh: "在当前工作区中运行交互式 Shell", en: "Run an interactive shell in this workspace" }, kind: "terminal", multiple: true, icon: () => <span aria-hidden="true" style={{ fontFamily: "monospace", fontSize: 24 }}>›_</span> },
    panels: [{ kind: "terminal", component: p => <WorkspaceTerminal model={p.resource(() => new TerminalSession(p.contentId, p.session.sessionId), model => model.dispose(), (model, active) => model.activate(active))} visible={p.visible} onNew={() => p.open("terminal", randomUUID(), p.locale === "zh" ? "终端" : "Terminal")} /> }],
  },
});
