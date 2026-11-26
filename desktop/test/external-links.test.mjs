import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ExternalLinkPreferences } from "../external-links.mjs";

const builder = createRequire(import.meta.url)("../builder.cjs");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-external-links-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, "external-links.json");
}

test("external-link preferences ship inside the desktop application", () => {
  assert.ok(builder.files.includes("external-links.mjs"));
});

test("confirmation stays opt-in by default and always-open persists across launches", async t => {
  const path = await fixture(t);
  const first = new ExternalLinkPreferences(path);
  await first.load();
  assert.equal(first.always, false);
  await first.setAlways(true);
  const second = new ExternalLinkPreferences(path);
  await second.load();
  assert.equal(second.always, true);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { alwaysOpen: true });
  await second.setAlways(false);
  const third = new ExternalLinkPreferences(path);
  await third.load();
  assert.equal(third.always, false);
});

test("an unreadable preference file safely restores confirmation prompts", async t => {
  const path = await fixture(t);
  await writeFile(path, "not-json");
  const preferences = new ExternalLinkPreferences(path);
  await preferences.load();
  assert.equal(preferences.always, false);
});
