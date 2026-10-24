import { Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { DIAGRAM_PLUGIN } from "../contract/diagrams.ts";
export type RunPluginTool = (pluginId: string, cwd: string, sessionId: string, action: string, input: unknown) => Promise<unknown>;
const id = Type.String({ pattern: "^[\\w-]{1,80}$" });
const text = Type.String({ minLength: 1, maxLength: 500 });
const color = Type.String({ pattern: "^(#[a-fA-F0-9]{6}|#[a-fA-F0-9]{3}|transparent)$" });
const style = { strokeColor: Type.Optional(color), backgroundColor: Type.Optional(color), strokeStyle: Type.Optional(Type.Union([Type.Literal("solid"), Type.Literal("dashed"), Type.Literal("dotted")])), fontSize: Type.Optional(Type.Number({ minimum: 12, maximum: 96 })) };
const geometry = { x: Type.Optional(Type.Number({ minimum: -100000, maximum: 100000 })), y: Type.Optional(Type.Number({ minimum: -100000, maximum: 100000 })), width: Type.Optional(Type.Number({ minimum: 20, maximum: 10000 })), height: Type.Optional(Type.Number({ minimum: 20, maximum: 10000 })) };
const node = Type.Object({ id, label: text, kind: Type.Optional(Type.Union(["process", "decision", "terminal", "text", "group"].map(k => Type.Literal(k)))), ...geometry, ...style, groupId: Type.Optional(id) });
const edge = Type.Object({ id, from: id, to: id, label: Type.Optional(text), ...style, waypoints: Type.Optional(Type.Array(Type.Tuple([Type.Number({ minimum: -100000, maximum: 100000 }), Type.Number({ minimum: -100000, maximum: 100000 })]), { maxItems: 12 })) });
const graph = Type.Object({ nodes: Type.Array(node, { minItems: 1, maxItems: 30 }), edges: Type.Array(edge, { maxItems: 60 }), layout: Type.Optional(Type.Union([Type.Literal("top-down"), Type.Literal("left-right")])) });
const patch = Type.Object({ addNodes: Type.Optional(Type.Array(node, { maxItems: 30 })), addEdges: Type.Optional(Type.Array(edge, { maxItems: 60 })), updateNodes: Type.Optional(Type.Array(Type.Object({ id, label: text }), { maxItems: 30 })), updateElements: Type.Optional(Type.Array(Type.Object({ id, label: Type.Optional(text), ...geometry, ...style }), { maxItems: 60 })), removeIds: Type.Optional(Type.Array(id, { maxItems: 60 })) });
/** Same factory is used by the foreground extension and retained SDK sessions. */
export function diagramTools(run: RunPluginTool): ToolDefinition[] {
  return [
    { name: "diagram_reference", action: "reference", description: "Read the local Excalidraw composition format, layout guidance and a layered architecture example. Use before drawing a rich diagram. Does not access files or an external service.", parameters: Type.Object({}) },
    { name: "diagram_create", action: "create", description: "Create an editable Excalidraw diagram displayed directly in chat. Use for natural-language drawing requests; users need not name tools. For architecture/knowledge diagrams read diagram_reference first: nodes support text/group kinds, explicit coordinates, width/height, colors and fontSize; edges support dashed strokes and absolute waypoints. Compose layers and annotations, not just identical boxes. Unique stable ASCII IDs; Chinese labels supported. Browser preview/acceptance is required; this does not save a file or render PNG.", parameters: Type.Object({ title: text, graph }) },
    { name: "diagram_read", action: "read", description: "Read the latest synchronized diagram revision and compact native elements by ID. Always read before patching. Bound text uses containerId; shape IDs identify nodes. User manual edits are authoritative. Only explicitly selected diagrams are read.", parameters: Type.Object({ id, elementIds: Type.Optional(Type.Array(id, { maxItems: 100 })) }) },
    { name: "diagram_patch", action: "patch", description: "Propose local edits to an existing diagram after diagram_read. Supply its exact baseRevision. addNodes/addEdges, updateNodes (shape ID + label), updateElements (shape or unbound text ID + optional label, x/y, width/height, colors, fontSize, strokeStyle), removeIds (native IDs). Geometry updates reroute incident bound arrows; unrelated native elements retain their positions and text. Do not rearrange everything unless requested. Never claim the proposal was accepted or saved.", parameters: Type.Object({ id, baseRevision: Type.Integer({ minimum: 0 }), patch }) },
  ].map(({ name, action, description, parameters }) => ({
    name, label: name, description, parameters,
    async execute(_callId, input, signal, _update, ctx) {
      signal?.throwIfAborted();
      const result = await run(DIAGRAM_PLUGIN, ctx.cwd, ctx.sessionManager.getSessionId(), action, input);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result };
    },
  }));
}
