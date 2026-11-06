import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pruneReleases } from "../src/host/server/updates/release-prune.ts";
import { SelfUpdater } from "../src/host/server/updates/self-update.ts";

const old = new Date(Date.now() - 3 * 24 * 60 * 60_000);

async function fixture() {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-release-prune-"));
  const state = join(agentDir, "pi-web"), releases = join(state, "releases");
  const release = async (name: string, age = old) => {
    const root = join(releases, name, "node_modules", "pi-webapp");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "pi-webapp", version: name.split("-")[0] }));
    await utimes(join(releases, name), age, age);
    return root;
  };
  const launcher = (name: string) => join(releases, name, "node_modules", "pi-webapp", "bin", "pi-webapp.mjs");
  return { agentDir, state, releases, release, launcher };
}

test("prunes releases no live pointer names, keeping running, pointed-to and recent ones", async () => {
  const { agentDir, state, releases, release, launcher } = await fixture();
  try {
    const running = await release("0.1.53-run");
    for (const name of ["0.1.52-prev", "0.1.51-cand", "0.1.50-intent", "0.1.49-old", "0.1.30", "0.1.48-logged"]) await release(name);
    await release("0.1.54-fresh", new Date());
    await writeFile(join(state, "desktop-update.json"), JSON.stringify({ version: "0.1.53", launcher: launcher("0.1.53-run"),
      previous: { version: "0.1.52", launcher: launcher("0.1.52-prev") }, fallbackVersion: "0.1.30" }));
    await mkdir(join(state, "upgrade", "history"), { recursive: true });
    await writeFile(join(state, "upgrade", "candidate.json"), JSON.stringify({ packageRoot: join(releases, "0.1.51-cand", "node_modules", "pi-webapp") }));
    await writeFile(join(state, "upgrade", "history", "x-committed.json"), JSON.stringify({ packageRoot: join(releases, "0.1.48-logged") }));
    await mkdir(join(state, "update-history"), { recursive: true });
    await writeFile(join(state, "update-history", "y-failed.json"), JSON.stringify({ packageRoot: join(releases, "0.1.49-old") }));
    await mkdir(join(state, "hosted", "host-pair"), { recursive: true });
    await writeFile(join(state, "hosted", "host-pair", "intent.json"), JSON.stringify({ selections: [{ packageRoot: join(releases, "0.1.50-intent") }] }));
    await writeFile(join(state, "broken.json"), "{ not json");

    const removed = await pruneReleases({ agentDir, packageRoot: running });
    assert.deepEqual(removed.sort(), ["0.1.30", "0.1.48-logged", "0.1.49-old"]);
    for (const kept of ["0.1.53-run", "0.1.52-prev", "0.1.51-cand", "0.1.50-intent", "0.1.54-fresh"]) assert.ok(existsSync(join(releases, kept)), kept);
  } finally { await rm(agentDir, { recursive: true, force: true }); }
});

test("missing releases folder is a no-op", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-release-prune-empty-"));
  try { assert.deepEqual(await pruneReleases({ agentDir, packageRoot: agentDir }), []); }
  finally { await rm(agentDir, { recursive: true, force: true }); }
});

test("updater never prunes while an update transaction is unfinished", async () => {
  const { agentDir, state, releases, release } = await fixture();
  try {
    const running = await release("0.1.53-run");
    await release("0.1.49-old");
    const updater = new SelfUpdater({ agentDir, packageRoot: running, runNpm: async () => { throw new Error("npm must not run"); } });
    await writeFile(join(state, "update-transaction.json"), JSON.stringify({ schema: 1, id: "00000000-0000-4000-8000-000000000000", phase: "downloading",
      version: "0.1.54", channel: "stable", selectionPath: join(state, "update.json") }));
    assert.deepEqual(await updater.pruneReleases(), []);
    assert.ok(existsSync(join(releases, "0.1.49-old")));
    await writeFile(join(state, "update-transaction.json"), JSON.stringify({ schema: 1, id: "00000000-0000-4000-8000-000000000000", phase: "failed",
      version: "0.1.54", channel: "stable", selectionPath: join(state, "update.json") }));
    assert.deepEqual(await updater.pruneReleases(), ["0.1.49-old"]);
    assert.ok(existsSync(join(releases, "0.1.53-run")));
  } finally { await rm(agentDir, { recursive: true, force: true }); }
});
