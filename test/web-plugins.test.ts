import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebPluginCatalog } from "../extension/web-plugins.ts";

test("discovers a local Web plugin and serves only declared assets", async () => {
  const base = await mkdtemp(join(tmpdir(), "pi-web-plugin-"));
  const root = join(base, "plugin");
  const agentDir = join(base, "agent");
  const original = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    await mkdir(join(root, "dist"), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "@example/web", pi: { extensions: ["./dist/extension.js"] }, piWebapp: { apiVersion: 1, client: "./dist/client.js", style: "./dist/client.css" } }));
    await writeFile(join(root, "dist/extension.js"), "export default () => {};");
    await writeFile(join(root, "dist/client.js"), "plugin-client");
    await writeFile(join(root, "dist/client.css"), "plugin-style");
    const catalog = await WebPluginCatalog.discover(base, false, [root]);
    assert.deepEqual(catalog.ids(), ["@example/web"]);
    assert.deepEqual(catalog.extensionRoots, [await realpath(root)]);
    const view = catalog.view();
    assert.match(view.plugins[0]?.client ?? "", /^\/plugins\/%40example%2Fweb\/client.js\?v=[a-f0-9]{64}$/);
    assert.equal((await catalog.asset(view.plugins[0]!.client))?.bytes.toString(), "plugin-client");
    assert.equal(await catalog.asset("/plugins/%40example%2Fweb/extension.js"), null);
    await writeFile(join(root, "dist/client.js"), "new-client");
    await catalog.refreshAssets();
    assert.notEqual(catalog.view().plugins[0]?.client, view.plugins[0]?.client);
    assert.equal(await catalog.asset(view.plugins[0]!.client), null);
    assert.equal((await catalog.asset(catalog.view().plugins[0]!.client))?.bytes.toString(), "new-client");
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    manifest.piWebapp.apiVersion = 2;
    await writeFile(join(root, "package.json"), JSON.stringify(manifest));
    const unsupported = await WebPluginCatalog.discover(base, false, [root]);
    assert.deepEqual(unsupported.ids(), []);
    assert.match(unsupported.errors[0] ?? "", /Unsupported/);
  } finally {
    if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = original;
    await rm(base, { recursive: true, force: true });
  }
});
