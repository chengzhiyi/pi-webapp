import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { candidatePath, readCandidate, readUpgradeTransaction, recordUpgradeTransaction, rollbackSelection, selectCandidate, upgradeRoot, upgradeTransactionPath, writeCandidate } from "../bin/upgrade-transaction.mjs";
import { HostedPluginIntegration } from "../src/host/server/plugins/hosted/integration.ts";

async function agent(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "upgrade-transaction-")); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "pi-web"), { recursive: true });
  return root;
}
const candidateFor = (root: string, version: string, downgrade = false) =>
  writeCandidate(root, { id: randomUUID(), version, launcher: join(root, version, "bin/pi-webapp.mjs"), packageRoot: join(root, version), channel: "stable", downgrade });

test("npm selection keeps exactly one rollback entry and carries downgrade consent", async t => {
  const root = await agent(t), pointer = join(root, "pi-web/update.json");
  await writeFile(pointer, JSON.stringify({ version: "0.1.0", launcher: "/a", baseVersion: "0.0.9", previous: { version: "0.0.9", launcher: "/z" } }));
  const selection = await selectCandidate({ agentDir: root, desktop: false, currentVersion: "0.1.0", candidate: await candidateFor(root, "0.2.0") });
  const written = JSON.parse(await readFile(pointer, "utf8"));
  assert.equal(written.version, "0.2.0"); assert.equal(written.baseVersion, "0.0.9");
  assert.deepEqual(written.previous, { version: "0.1.0", launcher: "/a", baseVersion: "0.0.9" }, "never a recursively growing chain");
  assert.equal(written.allowDowngrade, undefined);
  assert.equal(await rollbackSelection(selection), true);
  assert.equal(JSON.parse(await readFile(pointer, "utf8")).version, "0.1.0");
  await selectCandidate({ agentDir: root, desktop: false, currentVersion: "0.1.0", candidate: await candidateFor(root, "0.0.5", true) });
  assert.equal(JSON.parse(await readFile(pointer, "utf8")).allowDowngrade, true);
});

test("rollback of a first-ever selection removes the pointer, and never touches one that changed", async t => {
  const root = await agent(t), pointer = join(root, "pi-web/update.json");
  const first = await selectCandidate({ agentDir: root, desktop: false, currentVersion: "0.1.0", candidate: await candidateFor(root, "0.2.0") });
  assert.equal(await rollbackSelection(first), true);
  await assert.rejects(readFile(pointer), { code: "ENOENT" });
  const second = await selectCandidate({ agentDir: root, desktop: false, currentVersion: "0.1.0", candidate: await candidateFor(root, "0.2.0") });
  await writeFile(pointer, "{\"version\":\"9.9.9\"}");
  assert.equal(await rollbackSelection(second), false);
  assert.equal(await readFile(pointer, "utf8"), "{\"version\":\"9.9.9\"}");
});

test("upgrade records fail open: unknown schema, garbage and expired candidates are kept aside and read as absent", async t => {
  const root = await agent(t);
  await candidateFor(root, "0.2.0");
  await writeFile(candidatePath(root), JSON.stringify({ ...JSON.parse(await readFile(candidatePath(root), "utf8")), schema: 99 }));
  assert.equal(await readCandidate(root), null);
  await candidateFor(root, "0.2.0");
  assert.equal(await readCandidate(root, Date.now() + 25 * 60 * 60_000), null, "older than a day");
  await writeFile(upgradeTransactionPath(root), "not json");
  assert.equal(await readUpgradeTransaction(root), null);
  const kept = await readdir(upgradeRoot(root));
  assert.ok(kept.some(name => name.startsWith("candidate.json.invalid-")));
  assert.ok(kept.some(name => name.startsWith("candidate.json.expired-")));
  assert.ok(kept.some(name => name.startsWith("transaction.json.invalid-")));
  await assert.rejects(writeCandidate(root, { id: "not-a-uuid", version: "0.2.0", launcher: "/x", packageRoot: "/x", channel: "stable", downgrade: false }), /Invalid/);
  const record = await recordUpgradeTransaction(root, { id: randomUUID(), phase: "rolled-back", version: "0.2.0", from: "0.1.0", message: "cause" });
  assert.equal((await readUpgradeTransaction(root))?.message, "cause");
  assert.ok((await readdir(join(upgradeRoot(root), "history"))).includes(`${record.id}-rolled-back.json`));
});

test("host health admission waits for plugin startup only up to its bound", async t => {
  const root = await agent(t);
  const integration = new HostedPluginIntegration({ root: join(root, "hosted"), hostVersion: "0.1.0", workerEntry: join(root, "worker.mjs"), ownerId: "owner", resolveSession: () => null });
  integration.start = () => new Promise<void>(() => {}); // A plugin start that never finishes.
  const began = Date.now();
  assert.equal(await integration.admit(50), false);
  assert.ok(Date.now() - began < 2000, "the host continues instead of waiting for the plugin");
  integration.start = async () => {};
  assert.equal(await integration.admit(50), true);
});
