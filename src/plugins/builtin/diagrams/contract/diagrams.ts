/** Small, inert wire format shared by tools, persistence and the lazy canvas. */
export const MAX_SCENE_BYTES = 512 * 1024;
export const MAX_ELEMENTS = 400;
export const DIAGRAM_PLUGIN = "@pi-webapp/diagrams";
export type NodeKind = "process" | "decision" | "terminal" | "text" | "group";
export interface DiagramStyle { strokeColor?: string; backgroundColor?: string; strokeStyle?: "solid" | "dashed" | "dotted"; fontSize?: number }
export interface DiagramNode extends DiagramStyle { id: string; label: string; kind?: NodeKind; x?: number; y?: number; width?: number; height?: number; groupId?: string }
export interface DiagramEdge extends DiagramStyle { id: string; from: string; to: string; label?: string; waypoints?: [number, number][] }
export interface DiagramElementUpdate extends DiagramStyle { id: string; label?: string; x?: number; y?: number; width?: number; height?: number }
export interface DiagramGraph { nodes: DiagramNode[]; edges: DiagramEdge[]; layout?: "top-down" | "left-right" }
export interface DiagramPatch { addNodes?: DiagramNode[]; addEdges?: DiagramEdge[]; updateNodes?: { id: string; label: string }[]; updateElements?: DiagramElementUpdate[]; removeIds?: string[] }
export interface SceneElement { id: string; type: string; x: number; y: number; width: number; height: number; isDeleted?: boolean; text?: string; containerId?: string | null; customData?: Record<string, unknown>; [key: string]: unknown }
export interface DiagramScene { type: "excalidraw"; version: 2; source: string; elements: SceneElement[]; appState: { viewBackgroundColor: string }; files: Record<string, never> }
export interface Candidate { id: string; baseRevision: number; graph?: DiagramGraph; patch?: DiagramPatch; elements?: Record<string, unknown>[] }
export interface DiagramDraft { id: string; title: string; revision: number; scene: DiagramScene; path: string | null; diskHash: string | null; savedRevision: number | null; candidate: Candidate | null }
export type DiagramSummary = Pick<DiagramDraft, "id" | "title" | "revision" | "path" | "savedRevision"> & { pending: boolean };
export class DiagramError extends Error { status: number; readonly reason?: string; constructor(message: string, status = 400, reason?: string) { super(message); this.name = "DiagramError"; this.status = status; this.reason = reason; } }
export function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function fail(message: string): never { throw new DiagramError(message); }
export function identifier(value: unknown): string { return typeof value === "string" && /^[\w-]{1,80}$/.test(value) ? value : fail("图形 ID 无效"); }
export function label(value: unknown): string { return typeof value === "string" && value.length > 0 && value.length <= 500 ? value : fail("文案须为 1–500 字符"); }
function geometry(value: Record<string, unknown>): Pick<DiagramNode, "x" | "y" | "width" | "height"> {
  const result: Pick<DiagramNode, "x" | "y" | "width" | "height"> = {};
  for (const key of ["x", "y", "width", "height"] as const) if (value[key] !== undefined) {
    const n = value[key];
    if (typeof n !== "number" || !Number.isFinite(n) || Math.abs(n) > 100000 || ((key === "width" || key === "height") && (n < 20 || n > 10000))) fail("节点坐标或尺寸无效");
    result[key] = n;
  }
  return result;
}
function style(value: Record<string, unknown>): DiagramStyle {
  const result: DiagramStyle = {};
  for (const key of ["strokeColor", "backgroundColor"] as const) if (value[key] !== undefined) {
    if (typeof value[key] !== "string" || !/^(#[\da-f]{6}|#[\da-f]{3}|transparent)$/i.test(value[key] as string)) fail("绘图颜色须为十六进制或 transparent");
    result[key] = value[key] as string;
  }
  if (value.strokeStyle !== undefined) {
    if (!["solid", "dashed", "dotted"].includes(String(value.strokeStyle))) fail("线型无效");
    result.strokeStyle = value.strokeStyle as DiagramStyle["strokeStyle"];
  }
  if (value.fontSize !== undefined) {
    if (typeof value.fontSize !== "number" || !Number.isFinite(value.fontSize) || value.fontSize < 12 || value.fontSize > 96) fail("字号须为 12–96");
    result.fontSize = value.fontSize;
  }
  return result;
}
function nodes(value: unknown): DiagramNode[] {
  if (!Array.isArray(value) || value.length > 30) fail("每次最多 30 个节点");
  return value.map(n => {
    if (!record(n)) fail("节点无效");
    const node: DiagramNode = { id: identifier(n.id), label: label(n.label), ...geometry(n), ...style(n) };
    if (n.kind !== undefined) { if (!["process", "decision", "terminal", "text", "group"].includes(String(n.kind))) fail("节点类型无效"); node.kind = n.kind as NodeKind; }
    if (n.groupId !== undefined) node.groupId = identifier(n.groupId);
    return node;
  });
}
function edges(value: unknown): DiagramEdge[] {
  if (!Array.isArray(value) || value.length > 60) fail("每次最多 60 条连线");
  return value.map(e => { if (!record(e)) fail("连线无效"); const edge: DiagramEdge = { id: identifier(e.id), from: identifier(e.from), to: identifier(e.to), ...style(e), ...(e.label === undefined ? {} : { label: label(e.label) }) };
    if (e.waypoints !== undefined) {
      if (!Array.isArray(e.waypoints) || e.waypoints.length > 12 || e.waypoints.some(p => !Array.isArray(p) || p.length !== 2 || p.some(n => typeof n !== "number" || !Number.isFinite(n) || Math.abs(n) > 100000))) fail("连线途经点无效");
      edge.waypoints = e.waypoints as [number, number][];
    }
    return edge; });
}
function unique(ids: string[]) { if (new Set(ids).size !== ids.length) fail("图形 ID 重复"); }
export function validateGraph(value: unknown): DiagramGraph {
  if (!record(value)) fail("图结构无效");
  const graph: DiagramGraph = { nodes: nodes(value.nodes), edges: edges(value.edges ?? []) };
  if (!graph.nodes.length) fail("至少需要一个节点");
  if (value.layout !== undefined) { if (value.layout !== "top-down" && value.layout !== "left-right") fail("布局无效"); graph.layout = value.layout; }
  unique([...graph.nodes, ...graph.edges].map(n => n.id));
  const ids = new Set(graph.nodes.filter(n => n.kind !== "text").map(n => n.id));
  const groups = new Set(graph.nodes.filter(n => n.kind === "group").map(n => n.id));
  for (const n of graph.nodes) if (n.groupId && (!groups.has(n.groupId) || n.groupId === n.id || n.kind === "group")) fail("分组引用无效");
  for (const e of graph.edges) if (!ids.has(e.from) || !ids.has(e.to)) fail("连线引用了不存在的节点");
  return graph;
}
export function validatePatch(value: unknown, scene: DiagramScene): DiagramPatch {
  if (!record(value)) fail("修改操作无效");
  const patch: DiagramPatch = { addNodes: nodes(value.addNodes ?? []), addEdges: edges(value.addEdges ?? []), updateNodes: [], removeIds: [] };
  if (!Array.isArray(value.updateNodes ?? []) || !Array.isArray(value.removeIds ?? [])) fail("修改操作无效");
  if (((value.updateNodes ?? []) as unknown[]).length > 30 || ((value.removeIds ?? []) as unknown[]).length > 60) fail("修改过多");
  patch.updateNodes = ((value.updateNodes ?? []) as unknown[]).map(n => { if (!record(n)) fail("节点修改无效"); return { id: identifier(n.id), label: label(n.label) }; });
  patch.removeIds = ((value.removeIds ?? []) as unknown[]).map(identifier);
  const live = scene.elements.filter(e => !e.isDeleted);
  const shapes = new Set(live.filter(e => ["rectangle", "diamond", "ellipse"].includes(e.type)).map(e => e.id));
  const ids = new Set(live.map(e => e.id));
  const occupied = new Set(scene.elements.map(e => e.id));
  for (const id of patch.removeIds) if (!ids.has(id)) fail(`待删除元素不存在：${id}`);
  for (const n of patch.updateNodes) if (!shapes.has(n.id) || patch.removeIds.includes(n.id)) fail(`待修改节点不存在：${n.id}`);
  for (const n of patch.addNodes!) { if (occupied.has(n.id)) fail(`元素 ID 已存在：${n.id}`); if (n.kind !== "text") shapes.add(n.id); }
  for (const e of patch.addEdges!) if (occupied.has(e.id) || !shapes.has(e.from) || !shapes.has(e.to) || patch.removeIds.includes(e.from) || patch.removeIds.includes(e.to)) fail("新增连线无效");
  unique([...patch.addNodes!, ...patch.addEdges!].map(n => n.id));
  unique(patch.updateNodes.map(n => n.id));
  if (!Array.isArray(value.updateElements ?? []) || ((value.updateElements ?? []) as unknown[]).length > 60) fail("元素修改过多");
  patch.updateElements = ((value.updateElements ?? []) as unknown[]).map(item => {
    if (!record(item)) fail("元素修改无效");
    const id = identifier(item.id), element = live.find(e => e.id === id);
    if (!element || patch.removeIds!.includes(id) || patch.updateNodes!.some(n => n.id === id)) fail("待修改元素不存在或操作重复");
    const update = { id, ...geometry(item), ...style(item), ...(item.label === undefined ? {} : { label: label(item.label) }) };
    if (Object.keys(update).length === 1) fail("元素修改为空");
    if (!["rectangle", "ellipse", "diamond", "text"].includes(element.type)) fail("此类型不支持直接修改，请修改其端点或重建连线");
    if (element.containerId) fail("请修改文本所属的图形，保持绑定一致");
    return update;
  });
  unique(patch.updateElements.map(n => n.id));
  const availableGroups = new Set([...live.filter(e => e.customData?.diagramKind === "group").map(e => e.id), ...patch.addNodes!.filter(n => n.kind === "group").map(n => n.id)]);
  for (const n of patch.addNodes!) if (n.groupId && (!availableGroups.has(n.groupId) || patch.removeIds!.includes(n.groupId) || n.kind === "group")) fail("分组引用无效");
  if (!patch.updateElements.length && !patch.addNodes!.length && !patch.addEdges!.length && !patch.updateNodes.length && !patch.removeIds.length) fail("修改为空");
  return patch;
}
/** Compact Excalidraw skeletons, not executable content or unrestricted native JSON. */
export function validateDrawing(value: unknown): Record<string, unknown>[] {
  if (typeof value === "string") {
    if (new TextEncoder().encode(value).length > MAX_SCENE_BYTES) fail("图稿超过 512 KiB");
    try { value = JSON.parse(value); } catch { fail("elements 须为有效 JSON 数组字符串"); }
  }
  if (!Array.isArray(value) || !value.length || value.length > 150) fail("每次需要 1–150 个绘图元素");
  if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_SCENE_BYTES) fail("图稿超过 512 KiB");
  const allowed = new Set(["type", "id", "x", "y", "width", "height", "text", "fontSize", "fontFamily", "strokeColor", "backgroundColor", "strokeWidth", "strokeStyle", "fillStyle", "roughness", "opacity", "angle", "roundness", "points", "start", "end", "startArrowhead", "endArrowhead", "label", "groupIds", "textAlign", "verticalAlign"]);
  const drawing = value.map(item => {
    if (!record(item) || Object.keys(item).some(k => !allowed.has(k))) fail("绘图元素包含不支持字段");
    if (!["rectangle", "ellipse", "diamond", "text", "line", "arrow"].includes(String(item.type))) fail("绘图类型不支持");
    const result: Record<string, unknown> = { ...item, id: identifier(item.id) };
    for (const key of ["x", "y", "width", "height", "fontSize", "strokeWidth", "roughness", "opacity", "angle"] as const) {
      const n = item[key];
      if (n !== undefined && (typeof n !== "number" || !Number.isFinite(n) || Math.abs(n) > 100000)) fail("绘图数值无效");
    }
    if (typeof item.x !== "number" || typeof item.y !== "number") fail("绘图坐标缺失");
    if (["rectangle", "ellipse", "diamond"].includes(String(item.type)) && (["width", "height"].some(k => typeof item[k] !== "number" || (item[k] as number) < 20 || (item[k] as number) > 10000))) fail("绘图尺寸无效");
    if (item.fontSize !== undefined && ((item.fontSize as number) < 12 || (item.fontSize as number) > 96)) fail("字号须为 12–96");
    if (item.fontFamily !== undefined && item.fontFamily !== 5) fail("绘图默认使用本地 Excalifont");
    style(item);
    if (item.type === "text") label(item.text);
    else if (item.text !== undefined) fail("形状文字请放入 label");
    for (const [key, max] of [["roughness", 3], ["opacity", 100], ["strokeWidth", 16]] as const) if (item[key] !== undefined && ((item[key] as number) < 0 || (item[key] as number) > max)) fail("绘图样式数值无效");
    for (const key of ["width", "height"] as const) if (item[key] !== undefined && ((item[key] as number) < 0 || (item[key] as number) > 10000)) fail("绘图尺寸无效");
    if (item.label !== undefined) {
      if (!record(item.label) || Object.keys(item.label).some(k => !["text", "fontSize", "fontFamily", "textAlign", "verticalAlign"].includes(k))) fail("绘图标签无效");
      label(item.label.text); style(item.label);
      if (item.label.fontFamily !== undefined && item.label.fontFamily !== 5) fail("绘图标签字体无效");
    }
    for (const target of [item, item.label].filter(record)) {
      if (target.textAlign !== undefined && !["left", "center", "right"].includes(String(target.textAlign))) fail("文字对齐无效");
      if (target.verticalAlign !== undefined && !["top", "middle", "bottom"].includes(String(target.verticalAlign))) fail("文字对齐无效");
    }
    if (item.fillStyle !== undefined && !["solid", "hachure", "cross-hatch", "zigzag"].includes(String(item.fillStyle))) fail("填充样式无效");
    if (item.roundness !== undefined && (!record(item.roundness) || Object.keys(item.roundness).some(k => k !== "type") || ![1, 2, 3].includes(item.roundness.type as number))) fail("圆角无效");
    for (const key of ["startArrowhead", "endArrowhead"] as const) if (item[key] !== undefined && item[key] !== null && !["arrow", "bar", "dot", "triangle"].includes(String(item[key]))) fail("箭头样式无效");
    for (const key of ["start", "end"] as const) if (item[key] !== undefined) {
      const binding = item[key];
      if (!record(binding) || Object.keys(binding).some(k => k !== "id")) fail("端点绑定无效");
      identifier(binding.id);
    }
    if (item.groupIds !== undefined && (!Array.isArray(item.groupIds) || item.groupIds.length > 10 || item.groupIds.some(id => typeof id !== "string" || id.length > 100 || !/^[\p{L}\p{N}_-]{1,100}$/u.test(id)))) fail("元素分组无效：groupIds 须为最多 10 个非空文字/数字/下划线/连字符 ID，每个不超过 100 字符");
    if (["arrow", "line"].includes(String(item.type)) && (!Array.isArray(item.points) || item.points.length < 2 || item.points.length > 100 || item.points.some(p => !Array.isArray(p) || p.length !== 2 || p.some(n => typeof n !== "number" || !Number.isFinite(n) || Math.abs(n) > 100000)))) fail("路径坐标无效");
    return structuredClone(result);
  });
  unique(drawing.map(e => e.id as string));
  const shapes = new Set(drawing.filter(e => ["rectangle", "ellipse", "diamond"].includes(String(e.type))).map(e => e.id));
  for (const e of drawing) for (const key of ["start", "end"]) if (record(e[key]) && !shapes.has(e[key].id)) fail("连线引用了不存在的形状");
  return drawing;
}

/** Parse only complete top-level objects from a streamed JSON array, respecting quoted braces. */
export function partialDrawing(text: string): unknown[] {
  if (text.length > MAX_SCENE_BYTES || !text.trimStart().startsWith("[")) return [];
  const items: unknown[] = [];
  let depth = 0, start = -1, quoted = false, escaped = false;
  for (let i = text.indexOf("[") + 1; i < text.length; i++) {
    const c = text[i];
    if (quoted) { if (escaped) escaped = false; else if (c === "\\\\") escaped = true; else if (c === '"') quoted = false; continue; }
    if (c === '"') { quoted = true; continue; }
    if (c === "{") { if (depth++ === 0) start = i; }
    if (c === "}" && --depth === 0 && start >= 0) { try { items.push(JSON.parse(text.slice(start, i + 1))); } catch { return items; } if (items.length >= 150) return items; }
  }
  return items;
}
export function emptyScene(): DiagramScene { return { type: "excalidraw", version: 2, source: "pi-webapp", elements: [], appState: { viewBackgroundColor: "#ffffff" }, files: {} }; }
/** Only inert native geometry. Reject imports we cannot round-trip; never silently strip images. */
export function validateScene(value: unknown): DiagramScene {
  if (!record(value) || value.type !== "excalidraw" || value.version !== 2 || !Array.isArray(value.elements) || value.elements.length > MAX_ELEMENTS) fail("无效或过大的 Excalidraw 场景");
  if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_SCENE_BYTES) fail("图稿超过 512 KiB");
  if (value.files !== undefined && (!record(value.files) || Object.keys(value.files).length)) fail("首期不支持嵌入图片或附件");
  const elements = value.elements as SceneElement[];
  const ids: string[] = [];
  for (const e of elements) {
    if (!record(e) || typeof e.id !== "string" || !e.id || e.id.length > 100 || !["rectangle", "ellipse", "diamond", "text", "line", "arrow", "freedraw", "frame"].includes(e.type as string)) fail("场景包含不支持的元素");
    ids.push(e.id);
    for (const key of ["x", "y", "width", "height", "angle", "fontSize", "strokeWidth"] as const) if (e[key] !== undefined && (typeof e[key] !== "number" || !Number.isFinite(e[key]) || Math.abs(e[key] as number) > 100000)) fail("图形数值无效");
    for (const key of ["x", "y", "width", "height"] as const) if (typeof e[key] !== "number") fail("图形尺寸缺失");
    if (e.link || e.fileId || e.type === "embeddable" || e.type === "iframe") fail("首期不支持外链或嵌入资源");
    if (e.text !== undefined && (typeof e.text !== "string" || e.text.length > 2000)) fail("图形文案过长");
    if (e.width < 0 || e.height < 0 || (typeof e.fontSize === "number" && (e.fontSize < 1 || e.fontSize > 200))) fail("图形尺寸或字号无效");
    if (e.groupIds !== undefined && (!Array.isArray(e.groupIds) || e.groupIds.some(id => typeof id !== "string" || id.length > 100))) fail("元素分组无效");
    if (e.boundElements != null && (!Array.isArray(e.boundElements) || e.boundElements.some(b => !record(b) || typeof b.id !== "string" || !["arrow", "text"].includes(String(b.type))))) fail("元素绑定无效");
    for (const key of ["startBinding", "endBinding"] as const) if (e[key] != null) {
      const b = e[key];
      if (!record(b) || typeof b.elementId !== "string" || ["focus", "gap"].some(k => typeof b[k] !== "number" || !Number.isFinite(b[k]))) fail("连线绑定无效");
    }
    if (e.containerId != null && typeof e.containerId !== "string") fail("文本绑定无效");
    if (e.frameId != null && (typeof e.frameId !== "string" || !elements.some(frame => frame.id === e.frameId && frame.type === "frame"))) fail("画框引用无效");
    if (e.type === "frame" && e.name != null && (typeof e.name !== "string" || e.name.length > 2000)) fail("画框名称无效");
    if (e.fontFamily !== undefined && (typeof e.fontFamily !== "number" || !Number.isInteger(e.fontFamily) || e.fontFamily < 1 || e.fontFamily > 1000)) fail("字体无效");
    for (const key of ["strokeColor", "backgroundColor", "fillStyle", "strokeStyle"] as const) if (e[key] !== undefined && (typeof e[key] !== "string" || e[key].length > 100)) fail("图形样式无效");
    if (e.points !== undefined && (!Array.isArray(e.points) || e.points.length > 2000 || e.points.some(p => !Array.isArray(p) || p.length !== 2 || p.some(n => typeof n !== "number" || !Number.isFinite(n) || Math.abs(n) > 100000)))) fail("路径坐标无效");
  }
  unique(ids);
  const app = record(value.appState) ? value.appState : {};
  const color = typeof app.viewBackgroundColor === "string" && /^#[\da-f]{3,8}$/i.test(app.viewBackgroundColor) ? app.viewBackgroundColor : "#ffffff";
  return { type: "excalidraw", version: 2, source: "pi-webapp", elements: structuredClone(elements), appState: { viewBackgroundColor: color }, files: {} };
}
