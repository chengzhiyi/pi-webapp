import { convertToExcalidrawElements, restoreElements } from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import { emptyScene, validateScene, type Candidate, type DiagramGraph, type DiagramNode, type DiagramScene, type SceneElement } from "../contract/diagrams.ts";

function dimensions(n: DiagramNode) {
  const width = n.width ?? (n.kind === "group" ? 960 : n.label.length > 80 ? 480 : 240);
  const charsPerLine = n.kind === "decision" ? width / 50 : width / 24;
  const height = Math.max(n.kind === "decision" ? 160 : 100, Math.ceil(n.label.length / charsPerLine) * (n.kind === "decision" ? 52 : 28) + 40);
  return { width, height: n.height ?? (n.kind === "group" ? 220 : height) };
}
function nodeSkeleton(n: DiagramNode, x: number, y: number): ExcalidrawElementSkeleton {
  const common = { id: n.id, x: n.x ?? x, y: n.y ?? y, ...dimensions(n), roughness: 1,
    strokeColor: n.strokeColor ?? (n.kind === "group" ? "#a5b4fc" : "#1e1e1e"),
    backgroundColor: n.backgroundColor ?? (n.kind === "text" ? "transparent" : n.kind === "group" ? "#f5f3ff" : n.kind === "decision" ? "#fff3bf" : "#e7f5ff"),
    strokeStyle: n.strokeStyle ?? "solid" as const, fillStyle: "solid" as const,
    groupIds: n.kind === "group" ? [`group-${n.id}`] : n.groupId ? [`group-${n.groupId}`] : [],
    customData: { diagramNode: true, diagramKind: n.kind ?? "process" } };
  if (n.kind === "text") return { ...common, type: "text", text: n.label, fontSize: n.fontSize ?? 24, fontFamily: 5, autoResize: false };
  return { ...common, type: n.kind === "decision" ? "diamond" : n.kind === "terminal" ? "ellipse" : "rectangle",
    roundness: { type: 3 }, label: { text: n.label, fontSize: n.fontSize ?? (n.kind === "group" ? 18 : 20), fontFamily: 5, ...(n.kind === "group" ? { strokeColor: "#475569" } : {}),
      textAlign: n.kind === "group" ? "left" : "center", verticalAlign: n.kind === "group" ? "top" : "middle" } };
}
function layout(graph: DiagramGraph): ExcalidrawElementSkeleton[] {
  const order = new Map(graph.nodes.map((n, i) => [n.id, i]));
  const depths = graph.nodes.map(() => 0);
  // Forward edges define layers; back edges are deliberately not recursively expanded.
  for (let i = 0; i < graph.nodes.length; i++) for (const e of graph.edges) {
    const from = order.get(e.from)!, to = order.get(e.to)!;
    if (from === i && to > from) depths[to] = Math.max(depths[to]!, depths[from]! + 1);
  }
  const horizontal = graph.layout === "left-right";
  const extents = depths.map((depth, i) => ({ depth, ...dimensions(graph.nodes[i]!) }));
  const offsets: number[] = [0];
  for (let depth = 1; depth <= Math.max(...depths); depth++) offsets[depth] = offsets[depth - 1]! + Math.max(0, ...extents.filter(e => e.depth === depth - 1).map(e => horizontal ? e.width : e.height)) + 160;
  const lanes = new Map<number, number>();
  return graph.nodes.map((n, i) => {
    const depth = depths[i]!, lane = lanes.get(depth) ?? 0;
    const size = dimensions(n); lanes.set(depth, lane + (horizontal ? size.height : size.width) + 120);
    return nodeSkeleton(n, horizontal ? offsets[depth]! : lane, horizontal ? lane : offsets[depth]!);
  }).sort((a, b) => Number(b.customData?.diagramKind === "group") - Number(a.customData?.diagramKind === "group"));
}
function convert(skeletons: ExcalidrawElementSkeleton[]): SceneElement[] {
  return convertToExcalidrawElements(skeletons, { regenerateIds: false }) as unknown as SceneElement[];
}
function withEdges(elements: SceneElement[], edges: DiagramGraph["edges"]): SceneElement[] {
  if (!edges.length) return elements;
  const endpointIds = new Set(edges.flatMap(e => [e.from, e.to]));
  const endpoints = elements.filter(e => endpointIds.has(e.id)).map(e => ({ ...e, boundElements: [] }));
  const created = convert([
    ...endpoints as unknown as ExcalidrawElementSkeleton[],
    ...edges.map((e, index) => {
      const from = elements.find(n => n.id === e.from)!, to = elements.find(n => n.id === e.to)!;
      let points: [number, number][];
      if (from.id === to.id) {
        const x = from.x + from.width + 10, y = from.y + from.height / 2;
        points = [[x, y], [x + 80, y], [x + 80, from.y - 60], [from.x + from.width / 2, from.y - 60], [from.x + from.width / 2, from.y - 10]];
      } else if (to.y < from.y && Math.abs(to.x - from.x) < 260) {
        const lane = Math.min(from.x, to.x) - 80 - index * 20;
        points = [[from.x - 10, from.y + from.height / 2], [lane, from.y + from.height / 2], [lane, to.y + to.height / 2], [to.x - 10, to.y + to.height / 2]];
      } else if (to.x >= from.x + from.width + 40 || to.x + to.width + 40 <= from.x) {
        const right = to.x > from.x;
        points = [[right ? from.x + from.width + 10 : from.x - 10, from.y + from.height / 2], [right ? to.x - 10 : to.x + to.width + 10, to.y + to.height / 2]];
      } else {
        const down = to.y >= from.y;
        points = [[from.x + from.width / 2, down ? from.y + from.height + 10 : from.y - 10], [to.x + to.width / 2, down ? to.y - 10 : to.y + to.height + 10]];
      }
      if (e.waypoints?.length) points = [points[0]!, ...e.waypoints, points.at(-1)!];
      const [x, y] = points[0]!;
      return { type: "arrow" as const, id: e.id, x, y, strokeColor: e.strokeColor ?? "#1e1e1e", strokeStyle: e.strokeStyle ?? "solid", points: points.map(([px, py]) => [px - x, py - y] as [number, number]), start: { id: e.from }, end: { id: e.to }, ...(e.label ? { label: { text: e.label, fontSize: e.fontSize ?? 18, fontFamily: 5 as const } } : {}), endArrowhead: "arrow" as const, customData: { diagramEdge: true } };
    }),
  ]);
  const result = elements.map(e => {
    const changed = created.find(n => n.id === e.id);
    if (!changed) return e;
    const prior = Array.isArray(e.boundElements) ? e.boundElements : [];
    const added = Array.isArray(changed.boundElements) ? changed.boundElements : [];
    return { ...e, boundElements: [...prior, ...added.filter(n => !prior.some(p => (p as { id: string }).id === (n as { id: string }).id))] };
  });
  return [...result, ...created.filter(e => !endpointIds.has(e.id))];
}
function finalize(scene: DiagramScene): DiagramScene {
  return validateScene({ ...scene, elements: restoreElements(scene.elements as unknown as ExcalidrawElement[], null) });
}
export function materialize(base: DiagramScene, candidate: Candidate): DiagramScene {
  if (candidate.elements) {
    const skeletons = candidate.elements.map(element => ({
      roughness: 1, fillStyle: "solid", ...element,
      ...(element.type === "text" ? { fontFamily: 5 } : {}),
      ...(element.label ? { label: { fontFamily: 5, fontSize: 20, ...(element.label as object) } } : {}),
    })) as unknown as ExcalidrawElementSkeleton[];
    return finalize({ ...emptyScene(), elements: convert(skeletons) });
  }
  if (candidate.graph) {
    const shapes = convert(layout(candidate.graph));
    return finalize({ ...emptyScene(), elements: withEdges(shapes, candidate.graph.edges) });
  }
  const patch = candidate.patch!;
  let elements = structuredClone(base.elements);
  const removed = new Set(patch.removeIds ?? []);
  // Bound labels and connected arrows are removed together, avoiding dangling native bindings.
  for (const e of elements) if ((e.containerId && removed.has(e.containerId)) || [e.startBinding, e.endBinding].some(b => b && removed.has((b as { elementId: string }).elementId))) removed.add(e.id);
  for (const e of elements) if (e.containerId && removed.has(e.containerId)) removed.add(e.id);
  elements = elements.filter(e => !removed.has(e.id)).map(e => ({ ...e,
    ...(Array.isArray(e.boundElements) ? { boundElements: e.boundElements.filter(b => !removed.has((b as { id: string }).id)) } : {}),
  }));
  const updates = [...(patch.updateNodes ?? []), ...(patch.updateElements ?? [])];
  const moved = new Set<string>();
  for (const update of updates) {
    const prior = elements.find(e => e.id === update.id)!;
    const { id: _id, label, ...properties } = update;
    const shape: SceneElement = { ...prior, ...properties };
    if ("x" in properties || "y" in properties || "width" in properties || "height" in properties) moved.add(shape.id);
    if (shape.type === "text") {
      const generated = convert([{ ...shape, text: label ?? shape.text, originalText: label ?? shape.originalText ?? shape.text, autoResize: false } as unknown as ExcalidrawElementSkeleton])[0]!;
      elements = elements.map(e => e.id === shape.id ? generated : e); continue;
    }
    const oldText = elements.find(e => e.type === "text" && e.containerId === shape.id);
    const generated = convert([{ ...shape, label: { id: oldText?.id, text: label ?? oldText?.originalText ?? oldText?.text ?? "", fontSize: "fontSize" in properties ? properties.fontSize : typeof oldText?.fontSize === "number" ? oldText.fontSize : 20, fontFamily: typeof oldText?.fontFamily === "number" ? oldText.fontFamily : 5,
      textAlign: oldText?.textAlign, verticalAlign: oldText?.verticalAlign } } as unknown as ExcalidrawElementSkeleton]);
    const newText = generated.find(e => e.type === "text")!;
    elements = elements.filter(e => e.id !== oldText?.id).map(e => e.id === shape.id ? { ...shape, width: generated.find(n => n.id === shape.id)!.width, height: generated.find(n => n.id === shape.id)!.height, boundElements: [...(Array.isArray(shape.boundElements) ? shape.boundElements.filter(b => (b as { id: string }).id !== oldText?.id) : []), { id: newText.id, type: "text" }] } : e);
    elements.push({ ...newText, ...(oldText ? { id: oldText.id, fontFamily: oldText.fontFamily } : {}) });
  }
  // Only reroute arrows incident to explicitly moved/resized shapes; unrelated native paths stay intact.
  const affected = elements.filter(e => e.type === "arrow" && [e.startBinding, e.endBinding].some(b => b && moved.has((b as { elementId: string }).elementId)) && e.startBinding && e.endBinding);
  const rerouted: DiagramGraph["edges"] = affected.map(e => ({ id: e.id, from: (e.startBinding as { elementId: string }).elementId, to: (e.endBinding as { elementId: string }).elementId,
    label: elements.find(n => n.containerId === e.id)?.text, strokeColor: typeof e.strokeColor === "string" ? e.strokeColor : undefined, strokeStyle: e.strokeStyle as "solid" | "dashed" | "dotted" }));
  const replaced = new Set(affected.map(e => e.id));
  elements = elements.filter(e => !replaced.has(e.id) && !(e.containerId && replaced.has(e.containerId))).map(e => ({ ...e, ...(Array.isArray(e.boundElements) ? { boundElements: e.boundElements.filter(b => !replaced.has((b as { id: string }).id)) } : {}) }));
  elements = withEdges(elements, rerouted);
  const right = Math.max(0, ...elements.filter(e => !e.isDeleted).map(e => e.x + e.width)) + 120;
  let nextY = 0;
  elements.push(...convert((patch.addNodes ?? []).map(n => { const shape = nodeSkeleton(n, right, nextY); nextY += dimensions(n).height + 160; return shape; })));
  elements.sort((a, b) => Number(b.customData?.diagramKind === "group") - Number(a.customData?.diagramKind === "group"));
  return finalize({ ...base, elements: withEdges(elements, patch.addEdges ?? []) });
}
