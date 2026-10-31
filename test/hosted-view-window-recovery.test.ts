import assert from "node:assert/strict";
import test from "node:test";
import { hostedApi } from "../src/host/client/hosted/api.ts";
import { HostedViewCoordinator } from "../src/host/server/plugins/hosted/views.ts";
import type { HostedMount, HostedViewInput } from "../src/contracts/hosted-plugins.ts";

const pluginId = "@chengzhiyi/pi-excalidraw";
const identity = { pluginId, sessionId: "window-session", generation: 3, mountId: "closed-window-preview" };
const scope = { ownerId: "owner", workspaceId: "workspace", sessionId: identity.sessionId };
const mount: HostedMount = { kind: "tool", sessionId: identity.sessionId, locale: "en", theme: "light", contentId: "drawing" };

function storage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return { get length() { return values.size; }, key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); } };
}

function browserStorage(t: test.TestContext, local: ReturnType<typeof storage>) {
  const originals = ["sessionStorage", "localStorage"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: local });
  t.after(() => {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
}

async function newWindow(name: string, session = storage()): Promise<typeof import("../src/host/client/hosted/view-journal.ts")> {
  // A new BrowserWindow has a new top-level browsing session; its origin's
  // localStorage survives, while the closed window's sessionStorage does not.
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: session });
  return import(`../src/host/client/hosted/view-journal.ts?window-recovery=${name}`);
}

test("closing a whole window retains the exact unconfirmed view capability for explicit recovery on reopening", async t => {
  const local = storage(); browserStorage(t, local);
  const coordinator = new HostedViewCoordinator(pluginId, identity.generation, 50, 20);
  t.after(() => coordinator.dispose());
  const { viewToken } = await coordinator.handle({ ...identity, operation: "register", kind: mount.kind }, scope);
  const first = await newWindow("closed-origin");
  first.rememberView(identity, viewToken, mount); first.markViewConnecting(viewToken);
  await coordinator.handle({ ...identity, viewToken, operation: "change", dirty: false, busy: false }, scope);
  // No checkpoint action is rejected here: the entire client disappeared, so
  // no frame remains to acknowledge the server's otherwise valid freeze.
  await assert.rejects(coordinator.freeze(), /Missing view flush acknowledgement/);

  const reopened = await newWindow("reopened-origin");
  const lost = reopened.priorViews().find(item => item.viewToken === viewToken);
  assert.ok(lost, "a new window must expose the closed window's recovery capability");
  assert.equal(lost.frameStarted, true);
  assert.equal(lost.contentId, mount.contentId);
  t.mock.method(hostedApi, "view", (input: HostedViewInput) => coordinator.handle(input, scope));
  assert.equal((await reopened.reconcileView(lost))?.state, "unconfirmed");
  await reopened.retainViewForRecovery(lost);
  assert.equal((await coordinator.handle({ ...identity, viewToken, operation: "reconcile" }, scope)).recovery?.state, "retained");
  assert.throws(() => coordinator.admitAction({ ...identity, viewToken, action: "sync" }, scope), /capability/);
  await coordinator.freeze();
});

test("a reopened window captures the lost drawing backup before a new editor can replace its shared key", async t => {
  const unsynced = JSON.stringify({ type: "excalidraw", elements: [{ id: "unconfirmed-local-geometry", x: 87 }] });
  const winning = JSON.stringify({ type: "excalidraw", elements: [{ id: "server-geometry", x: 1 }] });
  const backupKey = `pi-diagram:${identity.sessionId}:${mount.contentId}`;
  const local = storage({ [backupKey]: unsynced }); browserStorage(t, local);
  const first = await newWindow("backup-before-close");
  const token = "dc5b8d8e-05c0-4c16-bbc3-157843493ce2";
  first.rememberView(identity, token, mount); first.markViewConnecting(token);

  const reopened = await newWindow("backup-after-close");
  const lost = reopened.priorViews().find(item => item.viewToken === token);
  assert.ok(lost, "surviving scene bytes need their exact lost-view recovery identity");
  local.setItem(backupKey, winning);
  assert.deepEqual(reopened.recoveryDrafts(lost).map(draft => draft.json), [unsynced]);
  assert.equal(local.getItem(backupKey), winning, "recovery discovery must not overwrite a winning drawing");
});

test("discovering another window's journal never automatically retires or acknowledges its live authoring view", async t => {
  const local = storage(); browserStorage(t, local);
  const coordinator = new HostedViewCoordinator(pluginId, identity.generation, 50, 20);
  t.after(() => coordinator.dispose());
  const { viewToken } = await coordinator.handle({ ...identity, operation: "register", kind: mount.kind }, scope);
  const first = await newWindow("still-open-origin");
  first.rememberView(identity, viewToken, mount); first.markViewConnecting(viewToken);
  await coordinator.handle({ ...identity, viewToken, operation: "change", dirty: true, busy: false }, scope);
  const writes: HostedViewInput[] = [];
  t.mock.method(hostedApi, "view", async (input: HostedViewInput) => { writes.push(input); return coordinator.handle(input, scope); });
  await newWindow("concurrent-origin");
  assert.deepEqual(writes, [], "journal discovery must not manufacture close, discard, retain, or save acknowledgements");
  const release = coordinator.admitAction({ ...identity, viewToken, action: "sync" }, scope);
  release();
  assert.equal((await coordinator.handle({ ...identity, viewToken, operation: "reconcile" }, scope)).recovery?.state, "unconfirmed");
});

test("per-view persistence preserves concurrent window writes and a stale writer cannot resurrect a retired token", async t => {
  const local = storage(); browserStorage(t, local);
  const sessionA = storage(), sessionB = storage();
  const a = await newWindow("writer-a", sessionA);
  const tokenA = "e5069bd9-8dda-49ca-b33f-33358addcefd";
  a.rememberView(identity, tokenA, mount); a.markViewConnecting(tokenA);
  const b = await newWindow("writer-b", sessionB);
  const tokenB = "cfb88760-a77f-4884-9b44-34d54392df87";
  b.rememberView({ ...identity, mountId: "second-window-preview" }, tokenB, mount); b.markViewConnecting(tokenB);
  b.forgetView(tokenA); // A confirmed retirement is authoritative across windows.
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: sessionA });
  assert.equal(a.markViewConnecting(tokenA), false, "stale status must not erase another window's retirement receipt");
  a.rememberView(identity, tokenA, mount);
  const reopened = await newWindow("writer-reopened");
  assert.deepEqual(reopened.priorViews().map(item => item.viewToken), [tokenB]);
});

test("external unstarted views and controllers are not automatically reconciled or cancelled, even after this window reloads", async t => {
  const local = storage(); browserStorage(t, local);
  for (const kind of ["tool", "controller"] as const) {
    const coordinator = new HostedViewCoordinator(pluginId, identity.generation, 50, 20);
    t.after(() => coordinator.dispose());
    const viewIdentity = { ...identity, mountId: `live-unstarted-${kind}` };
    const { viewToken } = await coordinator.handle({ ...viewIdentity, operation: "register", kind }, scope);
    const first = await newWindow(`unstarted-original-${kind}`);
    first.rememberView(viewIdentity, viewToken, { ...mount, kind });
    const writes: HostedViewInput[] = [];
    const stub = t.mock.method(hostedApi, "view", async (input: HostedViewInput) => { writes.push(input); return coordinator.handle(input, scope); });
    const otherSession = storage();
    const second = await newWindow(`unstarted-other-${kind}`, otherSession);
    const lost = second.priorViews().find(item => item.viewToken === viewToken);
    assert.ok(lost);
    assert.equal(lost.discovered, true);
    assert.equal(await second.reconcileView(lost), undefined);
    const reloaded = await newWindow(`unstarted-other-reloaded-${kind}`, otherSession);
    const stillExternal = reloaded.priorViews().find(item => item.viewToken === viewToken);
    assert.ok(stillExternal);
    assert.equal(stillExternal.discovered, true, "discovery must not migrate a live foreign token into this window's own session journal");
    await reloaded.reconcileView(stillExternal);
    assert.deepEqual(writes, [], "even reconcile can retire controllers or fence late registrations");
    const release = coordinator.admitAction({ ...viewIdentity, viewToken, action: "initialize" }, scope);
    release();
    stub.mock.restore();
  }
});

test("a retirement racing a stale per-view write remains authoritative on the next window", async t => {
  const local = storage(); browserStorage(t, local);
  const sessionA = storage(), sessionB = storage();
  const a = await newWindow("race-writer-a", sessionA);
  const token = "408dd60e-8bc1-4db5-a9d2-2908dfcbe9d6";
  a.rememberView(identity, token, mount);
  const b = await newWindow("race-writer-b", sessionB);
  const setItem = local.setItem;
  let race = true;
  local.setItem = (key, value) => {
    // Model window B retiring the view after A has read its previous record,
    // but before A commits the now-stale connecting status.
    if (race && key.includes(token) && value.includes('"frameStarted":true')) {
      race = false;
      Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: sessionB });
      b.forgetView(token);
      Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: sessionA });
    }
    setItem(key, value);
  };
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: sessionA });
  a.markViewConnecting(token);
  assert.equal(race, false, "test must exercise the read/write interleaving");
  const reopened = await newWindow("race-writer-after-close");
  assert.deepEqual(reopened.priorViews(), []);
});

test("explicit recovery of a discovered controller accepts its retired receipt without pretending to save authoring data", async t => {
  const local = storage(); browserStorage(t, local);
  const coordinator = new HostedViewCoordinator(pluginId, identity.generation, 50, 20);
  t.after(() => coordinator.dispose());
  const { viewToken } = await coordinator.handle({ ...identity, operation: "register", kind: "controller" }, scope);
  const first = await newWindow("controller-before-close");
  first.rememberView(identity, viewToken, { ...mount, kind: "controller" });
  const reopened = await newWindow("controller-after-close");
  const item = reopened.priorViews().find(record => record.viewToken === viewToken);
  assert.ok(item);
  t.mock.method(hostedApi, "view", (input: HostedViewInput) => coordinator.handle(input, scope));
  await reopened.retainViewForRecovery(item);
  assert.deepEqual(reopened.priorViews(), []);
  assert.throws(() => coordinator.admitAction({ ...identity, viewToken, action: "initialize" }, scope), /capability/);
});

test("legacy session records migrate durably without treating an external unstarted view as this document's initialization", async t => {
  const local = storage(); browserStorage(t, local);
  const token = "48382d42-33d9-4dce-a5cf-a2eeaf75e99f";
  const legacy = storage({ "pi:hosted:unconfirmed-views:v1": JSON.stringify([{ ...identity, viewToken: token, kind: mount.kind, frameStarted: false }]) });
  const migrated = await newWindow("legacy-migration", legacy);
  assert.equal(migrated.priorViews()[0].viewToken, token);
  assert.notEqual(migrated.priorViews()[0].discovered, true);
  const reopened = await newWindow("legacy-after-full-close");
  const recovered = reopened.priorViews().find(item => item.viewToken === token);
  assert.ok(recovered);
  assert.equal(recovered.discovered, true);
});

test("a corrupt durable record retains its raw bytes and drawing backup instead of being overwritten", async t => {
  const backup = JSON.stringify({ elements: [{ id: "preserve-this-draft" }] });
  const backupKey = `pi-diagram:${identity.sessionId}:${mount.contentId}`;
  const local = storage({ [backupKey]: backup }); browserStorage(t, local);
  const token = "1491e9c7-916a-4025-aa67-752fe6ff9484";
  const first = await newWindow("before-durable-corruption");
  first.rememberView(identity, token, mount);
  const recordKey = Array.from({ length: local.length }, (_, index) => local.key(index)).find(key => key?.includes(token));
  assert.ok(recordKey, "the recovery capability must have its own durable record");
  const corrupt = "{interrupted-durable-view-write";
  local.setItem(recordKey, corrupt);
  const reopened = await newWindow("after-durable-corruption");
  assert.match(reopened.recoveryJournalProblem(), /retained/);
  reopened.rememberView(identity, token, mount);
  assert.equal(reopened.markViewConnecting(token), false);
  assert.equal(local.getItem(recordKey), corrupt);
  assert.equal(local.getItem(backupKey), backup);
});

test("durable storage failure leaves ordinary startup usable but prevents an unprotected authoring frame", async t => {
  const local = storage(); browserStorage(t, local);
  local.setItem = () => { throw new Error("Storage quota exceeded"); };
  const journal = await newWindow("durable-storage-denied");
  assert.doesNotThrow(() => journal.rememberView(identity, "quota-token", mount));
  assert.equal(journal.markViewConnecting("quota-token"), false);
  assert.match(journal.recoveryJournalProblem(), /stored|storage|Keep this page/);
});
