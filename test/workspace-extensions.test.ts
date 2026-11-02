import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { WorkspaceSessions } from "../src/host/server/sessions/workspace-sessions.ts";

test("nested SDK sessions load ordinary Pi extensions without reloading pi-webapp", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workspace-extensions-"));
  const pkg = join(root, "ordinary-extension");
  const cwd = join(root, "workspace");
  const savedAgent = process.env.PI_CODING_AGENT_DIR;
  const global = globalThis as any;
  const probe: string[] = [];
  global.__PI_NESTED_EXTENSION_PROBE__ = probe;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  await mkdir(pkg, { recursive: true });
  await mkdir(cwd);
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "ordinary-extension", type: "module", pi: { extensions: ["./index.ts"] } }));
  await writeFile(join(pkg, "index.ts"), `export default function(pi) {
    pi.registerTool({
      name: 'nested_probe', label: 'Nested probe', description: 'Verify ordinary extension loading',
      parameters: {type: 'object', properties: {}},
      async execute() { return {content: [{type: 'text', text: 'ok'}], details: undefined}; },
    });
    pi.on('session_start', () => { globalThis.__PI_NESTED_EXTENSION_PROBE__.push('ordinary'); });
  }`);
  const settings = SettingsManager.create(cwd);
  settings.setExtensionPaths([pkg, fileURLToPath(new URL("./fixtures/nested-self-extension.ts", import.meta.url))]);
  await settings.flush();
  const host = new WorkspaceSessions(() => {}, () => undefined);
  try {
    await host.open(cwd, "new");
    assert.ok(host.session!.getAllTools().some(tool => tool.name === "nested_probe"));
    assert.deepEqual(probe, ["ordinary"]);
    await host.reload();
    assert.ok(host.session!.getAllTools().some(tool => tool.name === "nested_probe"));
    assert.deepEqual(probe, ["ordinary", "ordinary"]);
  } finally {
    await host.dispose();
    delete global.__PI_NESTED_EXTENSION_PROBE__;
    if (savedAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedAgent;
    await rm(root, { recursive: true, force: true });
  }
});
