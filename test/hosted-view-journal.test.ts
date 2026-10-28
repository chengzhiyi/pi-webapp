import test from "node:test";
import assert from "node:assert/strict";
import { recoveryDrafts } from "../src/host/client/hosted/view-journal.ts";

const identity = { pluginId: "@chengzhiyi/pi-excalidraw", sessionId: "session", generation: 8, mountId: "old-editor", viewToken: "old-token", kind: "editor" as const, contentId: "drawing" };
function storage(values: Record<string, string>) {
  const data = new Map(Object.entries(values));
  return { get length() { return data.size; }, key: (index: number) => [...data.keys()][index] ?? null,
    getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
}

test("local recovery exports only matching official drawing backups and never restores or deletes them", t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const backup = JSON.stringify({ type: "excalidraw", elements: [{ id: "unsynced-local-edit", type: "rectangle" }] });
  const local = storage({ "pi-diagram:session:drawing": backup, "pi-diagram:other:drawing": backup, "pi-diagram:session:other-drawing": backup });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: local });
  t.after(() => previous ? Object.defineProperty(globalThis, "localStorage", previous) : Reflect.deleteProperty(globalThis, "localStorage"));
  assert.deepEqual(recoveryDrafts(identity), [{ name: "recovery-drawing.excalidraw", json: backup }]);
  assert.deepEqual(recoveryDrafts({ ...identity, pluginId: "other-plugin" }), []);
  assert.equal(local.getItem("pi-diagram:session:drawing"), backup);
});

test("blocked browser storage does not crash ordinary chat or pretend a backup exists", t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { get length() { throw new Error("Storage blocked"); } } });
  t.after(() => previous ? Object.defineProperty(globalThis, "localStorage", previous) : Reflect.deleteProperty(globalThis, "localStorage"));
  assert.deepEqual(recoveryDrafts(identity), []);
});

test("malformed previous-document journal is preserved without preventing fresh view startup", async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  const raw = "{partial previous-document recovery";
  const local = storage({ "pi:hosted:unconfirmed-views:v1": raw });
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: local });
  t.after(() => previous ? Object.defineProperty(globalThis, "sessionStorage", previous) : Reflect.deleteProperty(globalThis, "sessionStorage"));
  const freshModule = "../src/host/client/hosted/view-journal.ts?invalid-journal-test";
  const journal = await import(freshModule);
  assert.deepEqual(journal.prior, []);
  assert.match(journal.recoveryJournalProblem(), /retained/);
  journal.rememberView(identity, "new-view-token", { kind: "controller", sessionId: "session", locale: "en", theme: "light" });
  assert.equal(local.getItem("pi:hosted:unconfirmed-views:v1"), raw);
});

test("previous-document backup is copied before a new editor can replace the plugin's shared backup key", async t => {
  const previousSession = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage"), previousLocal = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const unsynced = JSON.stringify({ elements: [{ id: "latest-unconfirmed-edit", x: 99 }] });
  const winning = JSON.stringify({ elements: [{ id: "server-winning-edit", x: 1 }] });
  const local = storage({ "pi-diagram:session:drawing": unsynced });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: local });
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: storage({ "pi:hosted:unconfirmed-views:v1": JSON.stringify([identity]) }) });
  t.after(() => {
    if (previousSession) Object.defineProperty(globalThis, "sessionStorage", previousSession); else Reflect.deleteProperty(globalThis, "sessionStorage");
    if (previousLocal) Object.defineProperty(globalThis, "localStorage", previousLocal); else Reflect.deleteProperty(globalThis, "localStorage");
  });
  const freshModule = "../src/host/client/hosted/view-journal.ts?capture-prior-draft-test";
  const journal = await import(freshModule);
  local.setItem("pi-diagram:session:drawing", winning);
  assert.equal(journal.recoveryDrafts(journal.prior[0])[0].json, unsynced);
  assert.equal(local.getItem("pi-diagram:session:drawing"), winning);
});
