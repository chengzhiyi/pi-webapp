import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("transport and workbench dispatch registered contributions without importing capability internals", async () => {
  const bridge = await readFile(new URL("../src/host/server/transport/bridge.ts", import.meta.url), "utf8");
  const panel = await readFile(new URL("../src/host/client/PluginPanel.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(bridge, /from\s+["'][^"']*plugins\/builtin\/(?:git|files|terminal)\//);
  assert.doesNotMatch(panel, /from\s+["'][^"']*plugins\/builtin\/(?:git|files|terminal)\//);
  assert.match(bridge, /pluginRegistry\.dispatch/);
  assert.match(panel, /definition\.workbench/);
  const adapter = await readFile(new URL("../src/adapters/pi/extension.ts", import.meta.url), "utf8");
  assert.ok(adapter.split("\n").length < 15);
  assert.match(adapter, /export \{ default \}/);
});
