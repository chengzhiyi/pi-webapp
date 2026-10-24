import assert from "node:assert/strict";
import test from "node:test";
import { DiagramModel, diagramModel, flushDiagramModels } from "../src/plugins/builtin/diagrams/client/model.ts";
import { emptyScene, type DiagramDraft } from "../src/plugins/builtin/diagrams/contract/diagrams.ts";

// Client model tests use inert local storage and HTTP fixtures, never an actual provider or user browser.
test("unavailable models retain hand edits and backups, stop polling, and do not block the live drawing's chat sync", async t => {
  const storage = new Map<string, string>();
  const globals = { location: { hash: "" }, sessionStorage: { getItem: () => null }, localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) } };
  for (const [key, value] of Object.entries(globals)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => { if (original) Object.defineProperty(globalThis, key, original); else Reflect.deleteProperty(globalThis, key); });
  }
  const drafts = new Map<string, DiagramDraft>();
  const draft = (id: string): DiagramDraft => ({ id, title: id, scene: emptyScene(), revision: 0, savedRevision: null, path: null, diskHash: null, candidate: null });
  drafts.set("old", draft("old")); drafts.set("live", draft("live"));
  const requests: { action: string; id: string }[] = [];
  let status = 404, reason: string | undefined = "diagram_unavailable", message = "Gone";
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    const action = url.split("/").at(-1)!;
    const input = JSON.parse(options.body as string); requests.push({ action, id: input.id });
    const current = drafts.get(input.id);
    if (!current) return Response.json({ error: message, errorCode: "validation_error", reason }, { status });
    if (action === "sync") { current.scene = input.scene; current.revision++; }
    return Response.json(current);
  });
  const old = diagramModel("recovery-test", "old"); await old.refresh();
  const scene = { ...emptyScene(), elements: [{ id: "manual", type: "rectangle", x: 120, y: 30, width: 200, height: 100 }] };
  old.change(scene); drafts.delete("old"); await assert.rejects(old.flush(), /Gone/);
  assert.equal(old.getSnapshot().unavailable, true); assert.equal(old.getSnapshot().unsynced, true);
  assert.deepEqual(old.recoveryScene(), scene);
  const before = requests.length; await old.refresh(); await old.refresh(); assert.equal(requests.length, before);
  const live = diagramModel("recovery-test", "live"); await live.refresh(); live.change(scene);
  await flushDiagramModels("recovery-test");
  assert.equal(live.getSnapshot().unsynced, false); assert.equal(old.getSnapshot().unsynced, true);
  assert.equal(requests.filter(r => r.action === "sync" && r.id === "old").length, 1);
  assert.equal(storage.has("pi-diagram:recovery-test:old"), true);
  // An unmaterialized old candidate must not keep trying to initialize a dead ID from preview polling.
  drafts.set("pending", { ...draft("pending"), candidate: { id: "candidate", baseRevision: 0, elements: [{ id: "node", type: "rectangle", x: 0, y: 0 }] } });
  const pending = new DiagramModel("recovery-test", "pending"); await pending.refresh(); drafts.delete("pending"); await pending.refresh();
  const beforeInitialize = requests.length;
  await pending.initialize(() => { throw new Error("must not materialize unavailable candidate"); });
  assert.equal(requests.length, beforeInitialize);
  // A fresh page/model can also explicitly retrieve the original backup after the backend is gone.
  assert.deepEqual(new DiagramModel("recovery-test", "old").recoveryScene(), scene);
  storage.set("pi-diagram:recovery-test:invalid", '{"type":"excalidraw","elements":[{"type":"iframe"}]}');
  assert.equal(new DiagramModel("recovery-test", "invalid").recoveryScene(), null);
  for (const code of [401, 403, 409, 500, 404]) {
    status = code; reason = "other_error";
    const model = new DiagramModel("recovery-test", `not-missing-${code}`); await model.refresh();
    assert.equal(model.getSnapshot().unavailable, false);
  }
  status = 404; reason = undefined; message = "图稿不属于当前会话或服务已重启，请重新打开已保存文件";
  const legacy = new DiagramModel("recovery-test", "legacy"); await legacy.refresh(); assert.equal(legacy.getSnapshot().unavailable, true);
});
