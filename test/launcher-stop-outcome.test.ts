import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeStopOutcome } from "../bin/launcher-state.mjs";

test("normal exit between state sampling and stop-marker inspection is success, not a refused drain", async t => {
  const root = await mkdtemp(join(tmpdir(), "launcher-stop-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = join(root, "launcher.json"), marker = join(root, "launcher.stop");
  await writeFile(state, JSON.stringify({ nonce: "owner" })); await writeFile(marker, "owner");
  let first = true;
  const active = async () => {
    try {
      const value = JSON.parse(await readFile(state, "utf8"));
      // The real launcher has exited after the CLI sampled the prior owner.
      if (first) { first = false; await unlink(state); await unlink(marker); }
      return value;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  };
  assert.equal(await observeStopOutcome(active, marker, "owner"), "stopped");
});

test("a removed stop request with the same live owner remains an explicit refused drain", async t => {
  const root = await mkdtemp(join(tmpdir(), "launcher-stop-refused-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(await observeStopOutcome(async () => ({ nonce: "owner" }), join(root, "launcher.stop"), "owner"), "refused");
  await writeFile(join(root, "launcher.stop"), "owner");
  assert.equal(await observeStopOutcome(async () => ({ nonce: "owner" }), join(root, "launcher.stop"), "owner"), "pending");
});
