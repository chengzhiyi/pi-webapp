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
  elementsGuide: `Preferred drawing workflow: user speaks in the main chat → excalidraw_read_me → excalidraw_create_view({title, elements: JSON.stringify([...])}) → diagram is displayed in this tool result → Edit opens only the native Excalidraw editor. No second prompt form, no initial acceptance step. This is a local native adapter, not a remote MCP service. elements: 1–150 objects; types rectangle/ellipse/diamond/text/line/arrow. Each needs stable ASCII id and x/y. Shapes need width/height (20–10000); text needs text and preferably fontSize (16–36). Use label:{text,fontSize:20} for centered bound labels; optional textAlign and verticalAlign. Use separate text for headings. Safe colors #RRGGBB or transparent, fillStyle solid/hachure/cross-hatch/zigzag, strokeStyle solid/dashed/dotted, roundness:{type:3}, roughness:1, opacity:0–100, groupIds:[string] (up to 10 IDs; each 1–100 Unicode letters/digits, underscores or hyphens; e.g. ["core-layer_2", "核心层"]). Arrows/lines need points:[[0,0],[dx,dy],…] relative to x/y; bind with start:{id:shapeId}, end:{id:shapeId}; endArrowhead:arrow/bar/dot/triangle/null. No URLs, images, embeds, scripts or pseudo-elements. Put background zones first, then shapes, labels and purposeful arrows. Explicitly position generous 20–40px gaps; use pastel #a5d8ff/#d0bfff/#b2f2bb/#ffd8a8 and dark readable text. Chinese fonts are local. Tool arguments may render progressively; final rendering is authoritative. To change the current drawing: diagram_read({}) gets latest selected drawing and revision including hand edits, then diagram_patch for targeted changes; user confirms existing edits in chat. Full replacement via excalidraw_create_view with id/baseRevision also requires chat confirmation. Never rebuild unrelated manual content. Save/export are native menu actions; do not claim files or PNG exist before that.`,
  elementsExample: { title: "登录流程", elements: JSON.stringify([
    { type: "rectangle", id: "input", x: 40, y: 80, width: 220, height: 100, backgroundColor: "#a5d8ff", label: { text: "输入验证码", fontSize: 20 } },
    { type: "diamond", id: "check", x: 400, y: 60, width: 220, height: 140, backgroundColor: "#fff3bf", label: { text: "验证通过？", fontSize: 20 } },
    { type: "arrow", id: "verify", x: 260, y: 130, points: [[0, 0], [140, 0]], start: { id: "input" }, end: { id: "check" }, endArrowhead: "arrow" },
  ]) },
  guide: `Legacy graph shortcut: Draw locally; no Excalidraw account or external service is needed. Use diagram_create with title and graph. For simple flows omit coordinates and use top-down/left-right. For rich architecture use explicit x/y/width/height for ALL nodes, generous spacing and few purposeful arrows. nodes: process (rectangle), decision (diamond), terminal (ellipse), text (standalone title/annotation), group (background container, label top-left). Put background containers first; groupId on children associates native selection groups, not hierarchical layout. A group must exist and cannot nest. Supported styles: strokeColor/backgroundColor (#RGB/#RRGGBB/transparent), strokeStyle (solid/dashed/dotted), fontSize 12–96. Edges: id/from/to/optional label, strokeColor/strokeStyle/fontSize; optional waypoints are ABSOLUTE intermediate [x,y] coordinates, endpoints stay bound. No arrows to standalone text. Up to 30 nodes, 60 edges, 12 waypoints per edge. Leave room under a group's heading and around notes. Use separate text nodes for subtitles; do not connect every library in a false sequential chain. Chinese is supported by bundled fonts. A new drawing appears directly in chat and becomes editable automatically. Changes to existing drawings require review in chat; saving is separate. For edits call diagram_read first; use updateElements for geometry/styles or standalone text, updateNodes for bound labels, addNodes/addEdges/removeIds for structure. Do not target a bound text ID; target its container. Moving a shape reroutes its incident bound arrows; untouched paths and elements remain. Do not claim a candidate was accepted or a file saved.`,
  example: { title: "Pi 分层架构（构图示例，不是源码审计）", graph: architectureExample },
};
