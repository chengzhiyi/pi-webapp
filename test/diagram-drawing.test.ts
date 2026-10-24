import assert from "node:assert/strict";
import test from "node:test";
import { emptyScene, validateDrawing, partialDrawing, type DiagramDraft } from "../src/plugins/builtin/diagrams/contract/diagrams.ts";
import { DiagramStore } from "../src/plugins/builtin/diagrams/server/store.ts";

const elements = [{ type: "rectangle", id: "node", x: 20, y: 40, width: 240, height: 100, label: { text: "中文 {标签}", fontSize: 20 }, backgroundColor: "#a5d8ff" }];
test("raw drawing accepts inert compact elements and rejects external, malformed, oversized or dangling content", () => {
  assert.deepEqual(validateDrawing(JSON.stringify(elements)), elements);
  for (const input of [[], "not JSON", [{ ...elements[0], type: "iframe" }], [{ ...elements[0], link: "https://evil" }], [{ ...elements[0], label: { text: "hi", link: "https://evil" } }], [{ ...elements[0], x: Infinity }], [{ ...elements[0], width: -1 }], [...elements, elements[0]], [{ ...elements[0], groupIds: ["../../bad"] }], [{ type: "arrow", id: "arrow", x: 0, y: 0, points: [[0, 0], [50, 0]], end: { id: "absent" } }]]) assert.throws(() => validateDrawing(input));
  assert.deepEqual(partialDrawing('[{"type":"text","text":"{hi} \\\"quoted\\\"","x":1}, {"label":{"text":"unfinished'), [{ type: "text", text: '{hi} "quoted"', x: 1 }]);
  assert.deepEqual(partialDrawing("not an array"), []);
});

test("compact drawing groups accept normal IDs without weakening group validation", async () => {
  for (const groupIds of [[], ["group-entry"], ["Layer_2", "outer-group-123"], ["a".repeat(80)], ["核心层-1", "数据_2", "a".repeat(100)], Array.from({ length: 10 }, (_, i) => `layer-${i}`)]) {
    const grouped = [{ ...elements[0], groupIds }];
    assert.deepEqual(validateDrawing(grouped), grouped);
    assert.deepEqual(validateDrawing(JSON.stringify(grouped)), grouped);
    const store = new DiagramStore();
    const result = store.tool("/cwd", "session", "view", { elements: JSON.stringify(grouped) }) as { id: string };
    const draft = await store.action("/cwd", "session", "get", { id: result.id }, () => {}) as DiagramDraft;
    assert.deepEqual(draft.candidate?.elements?.[0]?.groupIds, groupIds);
  }
  for (const groupIds of [null, "group", [null], [42], [""], ["a".repeat(101)], ["a/b"], ["a.b"], ["a b"], ["\\\\"], ["a\nb"], Array(11).fill("group")]) {
    assert.throws(() => validateDrawing([{ ...elements[0], groupIds }]), /元素分组无效/);
  }
});

test("new view initializes automatically only once; edited drawings always keep review and revision protection", async () => {
  const store = new DiagramStore(), guard = () => {};
  const result = store.tool("/cwd", "session", "view", { elements: JSON.stringify(elements), title: "图" }) as { id: string; status: string };
  assert.equal(result.status, "pending_canvas");
  let draft = await store.action("/cwd", "session", "get", { id: result.id }, guard) as DiagramDraft;
  const native = { ...emptyScene(), elements: [{ id: "node", type: "rectangle", x: 20, y: 40, width: 240, height: 100 }] };
  draft = await store.action("/cwd", "session", "initialize", { id: result.id, revision: 0, candidateId: draft.candidate!.id, scene: native }, guard) as DiagramDraft;
  assert.equal(draft.revision, 1); assert.equal(draft.candidate, null);
  const read = store.tool("/cwd", "session", "read", {}) as { id: string; revision: number };
  assert.equal(read.id, result.id); assert.equal(read.revision, 1);
  store.tool("/cwd", "session", "view", { id: result.id, baseRevision: 1, elements: JSON.stringify(elements) });
  draft = await store.action("/cwd", "session", "get", { id: result.id }, guard) as DiagramDraft;
  await assert.rejects(store.action("/cwd", "session", "initialize", { id: result.id, revision: 1, candidateId: draft.candidate!.id, scene: emptyScene() }, guard), /只能自动/);
  const candidateId = draft.candidate!.id;
  draft = await store.action("/cwd", "session", "sync", { id: result.id, revision: 1, scene: { ...native, elements: native.elements.map(e => ({ ...e, x: 123 })) } }, guard) as DiagramDraft;
  await assert.rejects(store.action("/cwd", "session", "accept", { id: result.id, revision: 2, candidateId, scene: emptyScene() }, guard), /旧图稿/);
  assert.equal(draft.scene.elements[0]!.x, 123);
  const other = await store.action("/cwd", "session", "new", {}, guard) as DiagramDraft;
  await store.action("/cwd", "session", "focus", { id: result.id }, guard);
  assert.equal((store.tool("/cwd", "session", "read", {}) as { id: string }).id, result.id);
  assert.notEqual(other.id, result.id);
  assert.throws(() => store.tool("/cwd", "different", "read", {}));
});
