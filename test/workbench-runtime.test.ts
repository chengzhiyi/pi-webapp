import test from "node:test";
import assert from "node:assert/strict";
import { WebPluginRuntime } from "../src/host/client/plugin-manager.ts";

function definition(id: string, kind = "example", apiVersion = 1) {
  return { id, apiVersion: 1, activate() {}, workbench: { apiVersion, entry: { kind, label: "Example", description: "Description", icon: () => null }, panels: [{ kind, component: () => null }] } };
}

test("workbench contributions validate their own version, labels and cross-plugin panel identity", async () => {
  const modules = { valid: definition("valid"), duplicate: definition("duplicate"), unsupported: definition("unsupported", "other", 2), malformed: { ...definition("malformed", "third"), workbench: { ...definition("malformed").workbench, entry: { kind: "third", label: 42 } } } };
  const runtime = new WebPluginRuntime({ loadModule: async url => ({ default: modules[url as keyof typeof modules] }), loadStyle: async () => () => {}, report() {} });
  await runtime.start("one", async () => ({ plugins: Object.keys(modules).map(id => ({ id, client: id })), errors: [] }));
  assert.deepEqual(runtime.getSnapshot().plugins.map(plugin => plugin.id), ["valid"]);
  assert.equal(runtime.getSnapshot().ready, true);
  assert.match(runtime.getSnapshot().errors.join("\n"), /already registered/);
  assert.match(runtime.getSnapshot().errors.join("\n"), /Invalid workbench/);
  runtime.dispose();
  assert.equal(runtime.getSnapshot().ready, false);
  await runtime.start("one", async () => ({ plugins: [], errors: [] }));
  assert.equal(runtime.getSnapshot().ready, true);
  assert.deepEqual(runtime.getSnapshot().plugins, []);
  runtime.dispose();
});
