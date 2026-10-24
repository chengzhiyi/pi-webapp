import { defineWebPlugin, type WebSlotProps } from "@chengzhiyi/pi-web-protocol";
import type { WorkbenchPluginDefinition } from "../../../../contracts/workbench.ts";
import type { SessionView } from "../../../../contracts/bridge-contract.ts";
import { metadata } from "../contract/manifest.ts";
import { DiagramEditor, DiagramList } from "./DiagramPanel.tsx";
import { DiagramPreview } from "./DiagramPreview.tsx";
function Cards(p: WebSlotProps) {
  const session = p.session as SessionView | null;
  if (!session || !p.turn) return null;
  const ids = new Set(p.turn.toolCallIds);
  const cards = session.messages.filter(m => m.role === "tool" && !m.isError && m.toolCallId && ids.has(m.toolCallId) && ["diagram_create", "diagram_patch"].includes(m.toolName ?? "")).flatMap(m => {
    try { const data: unknown = JSON.parse(m.blocks.filter(b => b.kind === "text").map(b => b.text).join(""));
      if (data && typeof data === "object" && "id" in data && typeof data.id === "string" && /^[\w-]{1,80}$/.test(data.id) && "title" in data && typeof data.title === "string") return [{ id: data.id, title: data.title, call: m.toolCallId }];
    } catch { /* Failed or old tools remain plain tool messages. */ } return [];
  });
  return <>{cards.map(card => <DiagramPreview key={card.call} sessionId={session.sessionId} id={card.id} title={card.title} locale={p.locale} open={() => p.openPanel(`diagram:${card.id}`)} />)}</>;
}
export default defineWebPlugin<WorkbenchPluginDefinition>({
  id: metadata.id, apiVersion: 1, activate() {}, artifactTools: ["diagram_create", "diagram_patch"],
  slots: [{ id: "diagrams", slot: "turn.tail", component: Cards }],
  workbench: {
    apiVersion: 1,
    entry: { label: metadata.name, description: { zh: "AI 生成、手工编辑与本地图稿", en: "AI generation, manual editing and local files" }, kind: "diagrams", icon: ({ size }) => <span style={{ fontSize: size }}>✎</span> },
    panels: [{ kind: "diagrams", component: DiagramList }, { kind: "diagram", component: DiagramEditor }],
    resolvePanel: panelId => /^diagram:[\w-]{1,80}$/.test(panelId) ? { kind: "diagram", contentId: panelId.slice(8), title: "Excalidraw" } : null,
  },
});
