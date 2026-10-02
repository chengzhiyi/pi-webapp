import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkspaceSessions } from "../extension/workspace-sessions.ts";
import { SettingsManager } from "@earendil-works/pi-coding-agent";

test("SDK replacement emits shutdown, startup errors preserve the old session, and dispose is idempotent", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-lifecycle-"));
  const pkg = join(root, "plugin"); const cwd = join(root, "workspace");
  const savedAgent = process.env.PI_CODING_AGENT_DIR;
  const savedDev = process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS;
  const global = globalThis as any;
  const probe: string[] = [];
  global.__PI_LIFECYCLE_PROBE__ = probe;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS = pkg;
  await mkdir(join(pkg, "dist"), { recursive: true }); await mkdir(cwd);
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "probe", type: "module", pi: { extensions: ["./dist/extension.js"] }, piWebapp: { apiVersion: 1, client: "./dist/client.js" } }));
  await writeFile(join(pkg, "dist/client.js"), "export default {id:'probe',apiVersion:1,activate(){}};");
  await writeFile(join(pkg, "dist/extension.js"), `export default function(pi) {
    let off;
    pi.on('session_start', (_event, ctx) => {
      globalThis.__PI_LIFECYCLE_PROBE__.push('start');
      if (globalThis.__PI_LIFECYCLE_FAIL__) throw new Error('startup failed');
      off?.();
      off = pi.events.on('pi-webapp:action:v1', request => {
        if (request.pluginId !== 'probe') return;
        const respond = () => pi.events.emit('pi-webapp:action-response:v1', {requestId:request.requestId,ok:true,value:'ok'});
        if (request.action === 'delay') globalThis.__PI_LIFECYCLE_RESPOND__ = respond;
        else respond();
      });
      pi.appendEntry('probe/state', {enabled:true});
      pi.events.emit('pi-webapp:interaction-open:v1', {requestId:'startup-'+ctx.sessionManager.getSessionId(),sessionId:ctx.sessionManager.getSessionId(),pluginId:'probe',kind:'review',data:{}});
    });
    pi.on('session_shutdown', event => { off?.(); off = null; globalThis.__PI_LIFECYCLE_PROBE__.push(event.reason); });
  }`);
  const host = new WorkspaceSessions(() => {}, () => undefined);
  try {
    await host.open(cwd, "new");
    assert.equal(host.snapshot().interactions?.length, 1, "interaction host must exist before startup");
    await host.open(cwd, "new");
    assert.equal(probe.filter(x => x === "new").length, 1);
    const old = host.session;
    global.__PI_LIFECYCLE_FAIL__ = true;
    await assert.rejects(host.open(cwd, "new"), /startup failed/);
    assert.equal(host.session, old);
    assert.equal(probe.filter(x => x === "quit").length, 1);
    global.__PI_LIFECYCLE_FAIL__ = false;

    // Host reload replaces the runtime even with the same session ID.
    const late = host.invokePluginAction({ requestId: "late", sessionId: host.snapshot().sessionId, pluginId: "probe", action: "delay" });
    await new Promise(resolve => setImmediate(resolve));
    const rejection = assert.rejects(late, /runtime unloaded/);
    await host.reload();
    await rejection;

    const sessionId = host.snapshot().sessionId;
    process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS = "";
    await host.reload();
    assert.equal(host.snapshot().sessionId, sessionId);
    assert.deepEqual(host.catalog!.ids(), []);
    assert.deepEqual(host.snapshot().pluginEntries, []);
    await assert.rejects(host.invokePluginAction({ requestId: "removed", sessionId, pluginId: "probe", action: "echo" }), /未启用/);
    const settings = SettingsManager.create(cwd);
    settings.setExtensionPaths([pkg]); await settings.flush();
    await host.reload();
    assert.deepEqual(host.catalog!.ids(), ["probe"]);
    assert.ok(host.snapshot().pluginEntries.length >= 2, "persisted entries survive plugin removal and re-addition");
    const echo = () => host.invokePluginAction({ requestId: crypto.randomUUID(), sessionId, pluginId: "probe", action: "echo" });
    assert.equal(await echo(), "ok");
    await host.reload();
    assert.equal(await echo(), "ok");
    await host.dispose(); await host.dispose();
    assert.equal(probe.filter(x => x === "quit").length, 2);
  } finally {
    await host.dispose();
    delete global.__PI_LIFECYCLE_PROBE__; delete global.__PI_LIFECYCLE_FAIL__;
    delete global.__PI_LIFECYCLE_RESPOND__;
    if (savedAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedAgent;
    if (savedDev === undefined) delete process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS; else process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS = savedDev;
    await rm(root, { recursive: true, force: true });
  }
});
