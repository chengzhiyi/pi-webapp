import assert from "node:assert/strict";
import test from "node:test";
import { acceptsInteraction } from "../src/host/server/plugins/interaction-plugins.ts";
import { BUILTIN_IDS } from "../src/contracts/plugins.ts";

test("built-in plugins can ask the user and have the answer accepted, with or without an extension catalog", () => {
  const catalog = { has: (id: string) => id === "ext.plan" };
  assert.equal(acceptsInteraction(catalog, "ext.plan"), true);
  // The terminal's input approval: not in the web extension catalog, still answerable.
  assert.equal(acceptsInteraction(catalog, BUILTIN_IDS.terminal), true);
  assert.equal(acceptsInteraction(null, BUILTIN_IDS.terminal), true);
  assert.equal(acceptsInteraction(catalog, "ext.unknown"), false);
  assert.equal(acceptsInteraction(undefined, "ext.plan"), false);
});
