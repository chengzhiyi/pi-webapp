import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile, symlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { PersistentDiagramStore } from "../src/plugins/builtin/diagrams/server/persistence.ts";
import { DiagramError, emptyScene, type DiagramDraft } from "../src/plugins/builtin/diagrams/contract/diagrams.ts";

const scene = { ...emptyScene(), elements: [{ id: "box", type: "rectangle", x: 123, y: 50, width: 200, height: 100, groupIds: ["核心层-1"] }] };
const elements = [{ id: "box", type: "rectangle", x: 10, y: 20, width: 200, height: 100, groupIds: ["核心层-1"] }];
const guard = () => {};

test("durable IDs survive independent stores and a fresh Node process, including candidates, focus and hand edits", async t => {
  const root = await mkdtemp(join(tmpdir(), "diagram-durable-")); t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "workspace"); await mkdir(cwd);
  let store = new PersistentDiagramStore(join(root, "state"));
  const created = await store.tool(cwd, "session", "view", { title: "架构", elements }) as { id: string };
  store = new PersistentDiagramStore(join(root, "state"));
  let draft = await store.action(cwd, "session", "get", { id: created.id }, guard) as DiagramDraft;
  assert.deepEqual(draft.candidate?.elements, elements);
  draft = await store.action(cwd, "session", "initialize", { id: draft.id, revision: 0, candidateId: draft.candidate!.id, scene }, guard) as DiagramDraft;
  draft = await store.action(cwd, "session", "sync", { id: draft.id, revision: 1, scene: { ...scene, elements: scene.elements.map(e => ({ ...e, x: 999 })) } }, guard) as DiagramDraft;
  await store.tool(cwd, "session", "patch", { id: draft.id, baseRevision: 2, patch: { removeIds: ["box"] } });
  draft = await store.action(cwd, "session", "sync", { id: draft.id, revision: 2, scene: emptyScene() }, guard) as DiagramDraft;
  // Stale candidates (whose old targets may no longer exist) remain rejectable, never silently applied.
  const restarted = new PersistentDiagramStore(join(root, "state"));
  const stale = await restarted.action(cwd, "session", "get", { id: draft.id }, guard) as DiagramDraft;
  assert.equal(stale.candidate?.baseRevision, 2);
  await assert.rejects(restarted.action(cwd, "session", "accept", { id: draft.id, revision: 3, candidateId: stale.candidate!.id, scene }, guard), /旧图稿/);
  await restarted.action(cwd, "session", "reject", { id: draft.id, revision: 3, candidateId: stale.candidate!.id }, guard);
  draft = await restarted.action(cwd, "session", "sync", { id: draft.id, revision: 3, scene }, guard) as DiagramDraft;
  const moduleUrl = new URL("../src/plugins/builtin/diagrams/server/persistence.ts", import.meta.url).href;
  const script = `import { PersistentDiagramStore } from ${JSON.stringify(moduleUrl)}; const s = new PersistentDiagramStore(process.argv[1]); console.log(JSON.stringify(await s.action(process.argv[2], 'session', 'get', {id:process.argv[3]},()=>{})));`;
  const output = await promisify(execFile)(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script, join(root, "state"), cwd, draft.id]);
  assert.deepEqual(JSON.parse(output.stdout), draft);
  assert.equal((await restarted.tool(cwd, "session", "read", {}) as { id: string }).id, draft.id);
  for (const [path, session] of [[cwd, "other"], [root, "session"]]) await assert.rejects(restarted.action(path!, session!, "get", { id: draft.id }, guard), (e: unknown) => e instanceof DiagramError && e.reason === "diagram_unavailable");
  draft = await restarted.action(cwd, "session", "save", { id: draft.id, revision: draft.revision, path: "diagrams/saved.excalidraw" }, guard) as DiagramDraft;
  assert.equal((await new PersistentDiagramStore(join(root, "state")).action(cwd, "session", "get", { id: draft.id }, guard) as DiagramDraft).path, draft.path);
  await writeFile(join(cwd, draft.path!), JSON.stringify(emptyScene()));
  await assert.rejects(store.action(cwd, "session", "save", { id: draft.id, revision: draft.revision, path: draft.path }, guard), /外部修改/);
  assert.deepEqual(JSON.parse(await readFile(join(cwd, draft.path!), "utf8")), emptyScene());
});

test("concurrent durable instances enforce revisions, failed storage never reports success or empties state", async t => {
  const root = await mkdtemp(join(tmpdir(), "diagram-durable-race-")); t.after(() => rm(root, { recursive: true, force: true }));
  const a = new PersistentDiagramStore(root), b = new PersistentDiagramStore(root);
  const draft = await a.action("/cwd", "session", "import", { scene }, guard) as DiagramDraft;
  const attempts = await Promise.allSettled([a.action("/cwd", "session", "sync", { id: draft.id, revision: 0, scene }, guard), b.action("/cwd", "session", "sync", { id: draft.id, revision: 0, scene: emptyScene() }, guard)]);
  assert.equal(attempts.filter(a => a.status === "fulfilled").length, 1);
  assert.equal(attempts.filter(a => a.status === "rejected").length, 1);
  const folder = join(root, (await readdir(root))[0]!);
  const bytes = await readFile(join(folder, draft.id + ".json"), "utf8");
  await writeFile(join(folder, "scope.lock"), JSON.stringify({ pid: 2147483647 })); // abandoned process lock
  await assert.rejects(b.action("/cwd", "session", "get", { id: draft.id }, guard), /存储正忙/);
  assert.equal(await readFile(join(folder, draft.id + ".json"), "utf8"), bytes);
  await rm(join(folder, "scope.lock")); // simulated operator recovery after all writers are stopped
  assert.equal((await b.action("/cwd", "session", "get", { id: draft.id }, guard) as DiagramDraft).revision, 1);
  await writeFile(join(folder, draft.id + ".json"), "{broken");
  await assert.rejects(b.action("/cwd", "session", "get", { id: draft.id }, guard), (e: unknown) => e instanceof DiagramError && e.status === 500 && e.reason === "diagram_storage_error");
  assert.equal(await readFile(join(folder, draft.id + ".json"), "utf8"), "{broken");
  await writeFile(join(folder, draft.id + ".json"), bytes);
  const envelope = JSON.parse(bytes); envelope.sessionId = "different";
  await writeFile(join(folder, draft.id + ".json"), JSON.stringify(envelope));
  await assert.rejects(b.action("/cwd", "session", "get", { id: draft.id }, guard), /本地存储/);
  await writeFile(join(folder, draft.id + ".json"), bytes);
  await assert.rejects(b.action("/cwd", "session", "sync", { id: draft.id, revision: 1, scene }, () => { throw new DiagramError("会话已切换", 409); }), /切换/);
  assert.equal(await readFile(join(folder, draft.id + ".json"), "utf8"), bytes);
  const outside = join(root, "outside"); await mkdir(outside);
  const scoped = join(root, createHash("sha256").update(JSON.stringify(["/cwd", "linked"])).digest("hex"));
  await symlink(outside, scoped);
  await assert.rejects(a.action("/cwd", "linked", "new", {}, guard), /本地存储/);
  assert.deepEqual(await readdir(outside), []);
});
