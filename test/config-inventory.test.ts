import assert from "node:assert/strict";
import test from "node:test";
import { buildResourceInventory } from "../extension/config-inventory.ts";

test("shows installed packages and auto-discovered Pi resources with their origins", () => {
  const inventory = buildResourceInventory(
    [{ source: "example-pkg", scope: "user", filtered: false, installedPath: "/packages/example-pkg" }],
    {
      extensions: [{ path: "/packages/example-pkg/ext.ts", enabled: true, metadata: { source: "example-pkg", scope: "user", origin: "package" } }],
      skills: [{ path: "/workspace/.pi/skills/demo/SKILL.md", enabled: true, metadata: { source: "auto", scope: "project", origin: "top-level" } }],
      prompts: [], themes: [],
    },
  );
  assert.deepEqual(inventory.packages, [{ name: "example-pkg", path: "/packages/example-pkg", source: "example-pkg", scope: "user", enabled: true }]);
  assert.deepEqual(inventory.extensions, [{ name: "ext.ts", path: "/packages/example-pkg/ext.ts", source: "example-pkg", scope: "user", enabled: true }]);
  assert.deepEqual(inventory.skills, [{ name: "demo", path: "/workspace/.pi/skills/demo/SKILL.md", source: "auto", scope: "project", enabled: true }]);
});
