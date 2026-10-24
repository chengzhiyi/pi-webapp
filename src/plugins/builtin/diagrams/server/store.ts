import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { DiagramError, emptyScene, identifier, label, record, validateDrawing, validateGraph, validatePatch, validateScene, type DiagramDraft, type DiagramSummary } from "../contract/diagrams.ts";
import { readDiagram, saveDiagram } from "./files.ts";
import { diagramReference } from "../contract/reference.ts";

/** One store per running bridge. Drafts are session-owned; saved files are the durable interchange. */
export class DiagramStore {
  private readonly scopes = new Map<string, Map<string, DiagramDraft>>();
  private readonly saving = new Set<string>();
  private readonly focused = new Map<string, string>();
  private scopeKey(cwd: string, sessionId: string) { return JSON.stringify([cwd, sessionId]); }
  private scope(cwd: string, sessionId: string) {
    const key = JSON.stringify([cwd, sessionId]);
    let map = this.scopes.get(key); if (!map) { map = new Map(); this.scopes.set(key, map); }
    return map;
  }
  private draft(cwd: string, sessionId: string, id: unknown) {
    const draft = this.scope(cwd, sessionId).get(identifier(id));
    if (!draft) throw new DiagramError("图稿不属于当前会话或服务已重启，请重新打开已保存文件", 404);
    return draft;
  }
  private expected(draft: DiagramDraft, revision: unknown) {
    if (revision !== draft.revision || this.saving.has(draft.id)) throw new DiagramError("图稿修订已变化或正在保存，请刷新后重试；本地草稿仍可下载", 409);
  }
  list(cwd: string, sessionId: string): DiagramSummary[] { return [...this.scope(cwd, sessionId).values()].map(d => ({ id: d.id, title: d.title, revision: d.revision, path: d.path, savedRevision: d.savedRevision, pending: !!d.candidate })); }
  private add(cwd: string, sessionId: string, title: string) {
    const map = this.scope(cwd, sessionId);
    if (map.size >= 100) throw new DiagramError("当前会话图稿已达 100 份上限");
    const draft: DiagramDraft = { id: randomUUID(), title, revision: 0, scene: emptyScene(), path: null, diskHash: null, savedRevision: null, candidate: null };
    map.set(draft.id, draft); this.focused.set(this.scopeKey(cwd, sessionId), draft.id); return draft;
  }
  tool(cwd: string, sessionId: string, action: string, input: unknown) {
    if (!record(input)) throw new DiagramError("绘图工具输入无效");
    if (action === "reference") return structuredClone(diagramReference);
    if (action === "create") {
      const graph = validateGraph(input.graph), title = label(input.title);
      const draft = this.add(cwd, sessionId, title);
      draft.candidate = { id: randomUUID(), baseRevision: draft.revision, graph };
      return { id: draft.id, title, revision: draft.revision, status: "pending_canvas_acceptance", message: "结构已建立，图稿将在对话中自动呈现并可直接编辑，无需用户接受首次创建。尚未保存文件或生成 PNG。" };
    }
    if (action === "view") {
      const elements = validateDrawing(input.elements);
      const title = input.title === undefined ? "Excalidraw" : label(input.title);
      const draft = input.id === undefined ? this.add(cwd, sessionId, title) : this.draft(cwd, sessionId, input.id);
      if (input.id !== undefined) {
        this.expected(draft, input.baseRevision);
        if (draft.candidate) throw new DiagramError("请先在对话中处理已有修改", 409);
        // Full scene replacement is an explicit candidate, never a silent overwrite of hand edits.
      }
      draft.candidate = { id: randomUUID(), baseRevision: draft.revision, elements };
      return { id: draft.id, title: draft.title, revision: draft.revision, status: input.id === undefined ? "pending_canvas" : "pending_review", message: input.id === undefined ? "图稿将在对话中自动呈现并可直接编辑，无需用户接受首次创建。尚未写入工作区或导出图片。" : "修改已在对话中预览，保留原图，等待用户确认。" };
    }
    const draft = this.draft(cwd, sessionId, input.id ?? (action === "read" ? this.focused.get(this.scopeKey(cwd, sessionId)) : undefined));
    if (action === "read") {
      const selected = input.elementIds === undefined ? null : Array.isArray(input.elementIds) && input.elementIds.length <= 100 ? new Set(input.elementIds.map(identifier)) : (() => { throw new DiagramError("元素读取范围无效"); })();
      const all = draft.scene.elements.filter(e => !e.isDeleted);
      const live = selected ? all.filter(e => selected.has(e.id) || (e.containerId && selected.has(e.containerId))) : all.slice(0, 100);
      return { totalElements: all.length, truncated: !selected && all.length > live.length, id: draft.id, title: draft.title, revision: draft.revision, saved: draft.revision === draft.savedRevision, pending: !!draft.candidate,
        elements: live.map(e => ({ id: e.id, type: e.type, x: e.x, y: e.y, width: e.width, height: e.height, ...(e.text === undefined ? {} : { text: e.text }), ...(e.containerId ? { containerId: e.containerId } : {}), ...(e.startBinding ? { startBinding: e.startBinding } : {}), ...(e.endBinding ? { endBinding: e.endBinding } : {}), ...Object.fromEntries(["strokeColor", "backgroundColor", "strokeStyle", "fontSize", "groupIds", "customData"].filter(k => e[k] !== undefined).map(k => [k, e[k]])) })) };
    }
    if (action !== "patch") throw new DiagramError("未知绘图工具");
    this.expected(draft, input.baseRevision);
    if (draft.candidate) throw new DiagramError("请先在对话中应用已有修改或保留原图", 409);
    const patch = validatePatch(input.patch, draft.scene);
    draft.candidate = { id: randomUUID(), baseRevision: draft.revision, patch };
    return { id: draft.id, title: draft.title, revision: draft.revision, status: "pending_canvas_acceptance", message: "修改已在对话工具结果中预览，原图未被替换；请用户在对话中应用修改或保留原图。右侧仍可手动编辑原图。" };
  }
  async action(cwd: string, sessionId: string, action: string, input: Record<string, unknown>, guard: () => void) {
    guard();
    if (action === "list") return this.list(cwd, sessionId);
    if (action === "new") return structuredClone(this.add(cwd, sessionId, "未命名图稿"));
    if (action === "open") {
      const loaded = await readDiagram(cwd, input.path); guard();
      const prior = [...this.scope(cwd, sessionId).values()].find(d => d.path === input.path);
      // Opening a file never destroys an existing dirty draft.
      if (prior && prior.revision !== prior.savedRevision) throw new DiagramError("此文件已有未保存草稿，请先保存或另存", 409);
      const draft = this.add(cwd, sessionId, basename(input.path as string, ".excalidraw"));
      draft.scene = loaded.scene; draft.path = input.path as string; draft.diskHash = loaded.hash; draft.savedRevision = 0;
      return structuredClone(draft);
    }
    if (action === "import") {
      const scene = validateScene(input.scene);
      const draft = this.add(cwd, sessionId, typeof input.title === "string" ? label(input.title) : "导入图稿");
      draft.scene = scene; return structuredClone(draft);
    }
    const draft = this.draft(cwd, sessionId, input.id);
    if (action === "get") return structuredClone(draft);
    if (action === "focus") { this.focused.set(this.scopeKey(cwd, sessionId), draft.id); return { id: draft.id }; }
    this.expected(draft, input.revision);
    if (action === "sync") { draft.scene = validateScene(input.scene); draft.revision++; return structuredClone(draft); }
    if (action === "initialize" || action === "accept" || action === "reject") {
      const candidate = draft.candidate;
      if (!candidate || candidate.id !== input.candidateId) throw new DiagramError("候选已变化", 409);
      if (action === "initialize" && (draft.revision !== 0 || draft.scene.elements.length || candidate.patch)) throw new DiagramError("只能自动呈现尚未编辑的新图稿", 409);
      if (action === "accept" || action === "initialize") {
        if (candidate.baseRevision !== draft.revision) throw new DiagramError("候选基于旧图稿，不能覆盖最新手改；请拒绝后重新生成", 409);
        draft.scene = validateScene(input.scene); draft.revision++;
      }
      draft.candidate = null; return structuredClone(draft);
    }
    if (action === "save") {
      if (draft.candidate) throw new DiagramError("请先接受或拒绝修改候选");
      const revision = draft.revision;
      const expected = input.path === draft.path ? draft.diskHash : null;
      this.saving.add(draft.id);
      try {
        const hash = await saveDiagram(cwd, input.path, draft.scene, expected, () => { guard(); if (draft.revision !== revision) throw new DiagramError("保存期间图稿已修改", 409); });
        draft.path = input.path as string; draft.diskHash = hash; draft.savedRevision = revision;
        return structuredClone(draft);
      } finally { this.saving.delete(draft.id); }
    }
    throw new DiagramError("未知图稿操作");
  }
}
