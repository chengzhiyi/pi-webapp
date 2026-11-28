import { defineWebPlugin } from "@chengzhiyi/pi-web-protocol";
import type { WorkbenchPluginDefinition } from "../../../../contracts/workbench.ts";
import { metadata } from "../contract/manifest.ts";
import { TERMINAL_INPUT_APPROVAL } from "../contract/terminal.ts";
import { TerminalSession } from "./terminal-session.ts";
import { WorkspaceTerminal } from "./WorkspaceTerminal.tsx";
import { TerminalApproval, terminalApproval } from "./TerminalApproval.tsx";
import { randomUUID } from "../../../../host/client/random-uuid.ts";

export default defineWebPlugin<WorkbenchPluginDefinition>({
  id: metadata.id, apiVersion: 1, activate() {},
  // The composer shows the agent's request too; the targeted terminal tab shows the same one.
  interactions: [{ kind: TERMINAL_INPUT_APPROVAL, component: p => {
    const approval = terminalApproval(p.interaction);
    return approval && <TerminalApproval approval={approval} locale={p.locale} decide={value => p.resolveInteraction(value)} />;
  } }],
  workbench: {
    apiVersion: 1,
    entry: { category: "workspace", label: { zh: "打开终端", en: "Open terminal" }, panelTitle: metadata.name, description: { zh: "在当前工作区运行命令", en: "Run commands in this workspace" }, kind: "terminal", multiple: true, icon: ({ size = 24 }) => <span aria-hidden="true" style={{ fontFamily: "monospace", fontSize: size, lineHeight: 1 }}>›_</span> },
    panels: [{ kind: "terminal", component: p => <WorkspaceTerminal model={p.resource(() => new TerminalSession(p.contentId, p.session.sessionId), model => model.dispose(), (model, active) => model.activate(active))} visible={p.visible} sessionId={p.session.sessionId} interactions={p.session.interactions} onNew={() => p.open("terminal", randomUUID(), p.locale === "zh" ? "终端" : "Terminal")} /> }],
  },
});
