import type { DiagramGraph } from "./diagrams.ts";

/** Local format reference and regression fixture, not a model-quality claim. */
export const architectureExample: DiagramGraph = {
  nodes: [
    { id: "title", kind: "text", label: "Pi 架构总览", x: 330, y: 0, width: 600, height: 60, fontSize: 36 },
    { id: "entry", kind: "group", label: "① 入口 / 模式分发", x: 0, y: 100, width: 1280, height: 180, backgroundColor: "#eff6ff", strokeColor: "#93c5fd" },
    { id: "core", kind: "group", label: "② 应用核心", x: 0, y: 310, width: 1280, height: 210, backgroundColor: "#f5f3ff", strokeColor: "#c4b5fd" },
    { id: "runtime", kind: "group", label: "③ 运行时库", x: 0, y: 550, width: 1280, height: 200, backgroundColor: "#f0fdf4", strokeColor: "#86efac" },
    { id: "infra", kind: "group", label: "④ 基础设施", x: 0, y: 1000, width: 1280, height: 150, backgroundColor: "#fff7ed", strokeColor: "#fdba74" },
    { id: "cli", label: "pi CLI · main.ts", x: 110, y: 160, width: 360, height: 80, groupId: "entry", strokeColor: "#3b82f6", backgroundColor: "#bfdbfe" },
    { id: "modes", label: "interactive · print · rpc", x: 730, y: 160, width: 440, height: 80, groupId: "entry", strokeColor: "#3b82f6", backgroundColor: "#bfdbfe" },
    { id: "session", label: "AgentSession 核心", x: 100, y: 375, width: 450, height: 90, groupId: "core", strokeColor: "#8b5cf6", backgroundColor: "#ddd6fe", fontSize: 26 },
    { id: "manager", label: "SessionManager · JSONL", x: 790, y: 375, width: 380, height: 90, groupId: "core", strokeColor: "#22c55e", backgroundColor: "#bbf7d0" },
    { id: "tools", kind: "text", label: "内置工具：bash · fs · edit · grep", x: 110, y: 475, width: 500, height: 30, groupId: "core", fontSize: 16, strokeColor: "#64748b" },
    { id: "agent", label: "agent-core", x: 40, y: 610, width: 200, height: 80, groupId: "runtime", backgroundColor: "#ddd6fe", strokeColor: "#8b5cf6" },
    { id: "ai", label: "pi-ai", x: 300, y: 610, width: 190, height: 80, groupId: "runtime", backgroundColor: "#bfdbfe", strokeColor: "#3b82f6" },
    { id: "tui", label: "pi-tui", x: 550, y: 610, width: 190, height: 80, groupId: "runtime", backgroundColor: "#fef3c7", strokeColor: "#f59e0b" },
    { id: "code", label: "codemode", x: 800, y: 610, width: 190, height: 80, groupId: "runtime", backgroundColor: "#fed7aa", strokeColor: "#f97316" },
    { id: "mcp", label: "pi-mcp", x: 1050, y: 610, width: 190, height: 80, groupId: "runtime", backgroundColor: "#bbf7d0", strokeColor: "#22c55e" },
    { id: "fs", label: "文件系统 · 进程", x: 30, y: 820, width: 230, height: 80, strokeStyle: "dashed", backgroundColor: "#f8fafc", strokeColor: "#94a3b8" },
    { id: "providers", label: "Provider APIs", x: 300, y: 820, width: 240, height: 80, strokeStyle: "dashed", backgroundColor: "#f8fafc", strokeColor: "#94a3b8" },
    { id: "servers", label: "MCP servers", x: 1030, y: 820, width: 230, height: 80, strokeStyle: "dashed", backgroundColor: "#f8fafc", strokeColor: "#94a3b8" },
    { id: "infra-text", kind: "text", label: "chord · durable · protocol / server / client · env · telemetry", x: 80, y: 1070, width: 1140, height: 40, groupId: "infra", strokeColor: "#b45309" },
    { id: "experiment", label: "实验（非默认装配）：experimental server / client", x: 520, y: 1230, width: 740, height: 80, strokeStyle: "dashed", strokeColor: "#f59e0b", backgroundColor: "#fef3c7" },
  ],
  edges: [
    { id: "dispatch", from: "cli", to: "modes", waypoints: [[620, 200]] },
    { id: "shared", from: "modes", to: "session" },
    { id: "persist", from: "session", to: "manager", label: "事件 → 持久化", strokeColor: "#22c55e" },
    { id: "loop", from: "session", to: "agent" },
    { id: "stream", from: "agent", to: "ai" },
    { id: "filesystem", from: "agent", to: "fs", strokeColor: "#8b5cf6" },
    { id: "provider", from: "ai", to: "providers", strokeColor: "#3b82f6" },
    { id: "mcp-api", from: "mcp", to: "servers", strokeColor: "#22c55e" },
    { id: "dependency", from: "tui", to: "infra", strokeStyle: "dashed", strokeColor: "#94a3b8", label: "npm workspace 依赖" },
    { id: "experimental", from: "infra", to: "experiment", strokeStyle: "dashed", strokeColor: "#f59e0b" },
  ],
};

export const diagramReference = {
  guide: `Draw locally; no Excalidraw account or external service is needed. Use diagram_create with title and graph. For simple flows omit coordinates and use top-down/left-right. For rich architecture use explicit x/y/width/height for ALL nodes, generous spacing and few purposeful arrows. nodes: process (rectangle), decision (diamond), terminal (ellipse), text (standalone title/annotation), group (background container, label top-left). Put background containers first; groupId on children associates native selection groups, not hierarchical layout. A group must exist and cannot nest. Supported styles: strokeColor/backgroundColor (#RGB/#RRGGBB/transparent), strokeStyle (solid/dashed/dotted), fontSize 12–96. Edges: id/from/to/optional label, strokeColor/strokeStyle/fontSize; optional waypoints are ABSOLUTE intermediate [x,y] coordinates, endpoints stay bound. No arrows to standalone text. Up to 30 nodes, 60 edges, 12 waypoints per edge. Leave room under a group's heading and around notes. Use separate text nodes for subtitles; do not connect every library in a false sequential chain. Chinese is supported by bundled fonts. A tool call returns a candidate shown directly in chat; the user accepts before editing/exporting, and saving is separate. For edits call diagram_read first; use updateElements for geometry/styles or standalone text, updateNodes for bound labels, addNodes/addEdges/removeIds for structure. Do not target a bound text ID; target its container. Moving a shape reroutes its incident bound arrows; untouched paths and elements remain. Do not claim a candidate was accepted or a file saved.`,
  example: { title: "Pi 分层架构（构图示例，不是源码审计）", graph: architectureExample },
};
