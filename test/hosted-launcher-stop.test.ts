import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HostedPluginInstaller } from "../src/host/server/plugins/hosted/installer.ts";
import { HostedStateBroker } from "../src/host/server/plugins/hosted/state-broker.ts";
import { hostedId as id, integrationFixture, integrity } from "./helpers/hosted-integration-fixture.ts";
import { acquireStorageOwnership } from "../src/host/server/plugins/hosted/storage.ts";

const exec = promisify(execFile);
const launcher = fileURLToPath(new URL("../bin/pi-webapp.mjs", import.meta.url));
const cli = fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", import.meta.url));

test("real RPC launcher stop releases hosted ownership so restart can open and uninstall", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "hosted-launcher-stop-")), agentDir = join(root, "agent"), storage = join(agentDir, "pi-web/hosted");
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_WEBAPP_PI_CLI: cli, PI_WEBAPP_AUTO_OPEN: "0" };
  for (const key of ["PI_WEBAPP_RESTART_PORT", "PI_WEBAPP_RESTART_TOKEN", "PI_WEBAPP_LAUNCHER_NONCE", "PI_WEBAPP_PLUGIN_DEV_ROOTS"]) delete env[key as keyof typeof env];
  const run = (...args: string[]) => exec(process.execPath, [launcher, ...args], { cwd: root, env, timeout: 40_000 });
  const version = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version;
  const fixture = integrationFixture();
  await new HostedPluginInstaller({ root: join(storage, "packages"), hostVersion: version }).installArchive(id, fixture.bytes, integrity(fixture.bytes), "0.1.0");
  await mkdir(storage, { recursive: true });
  await writeFile(join(storage, "host-version.json"), JSON.stringify({ version }));
  const broker = new HostedStateBroker(join(storage, "data"), id);
  const lock = join(broker.root, "runtime.lock");
  const connect = async () => {
    const state = JSON.parse(await readFile(join(agentDir, "pi-web/launcher.json"), "utf8")), url = new URL(state.url);
    const headers = { Authorization: `Bearer ${url.hash.slice(1)}`, Origin: url.origin, "Content-Type": "application/json" };
    return {
      session: async () => (await (await fetch(url.origin + "/api/session", { headers })).json()).sessionId as string,
      view: (body: unknown) => fetch(url.origin + "/api/hosted-plugins/views", { method: "POST", headers, body: JSON.stringify(body) }),
      inventory: async () => (await (await fetch(url.origin + "/api/hosted-plugins", { headers })).json()).plugins[0],
      manage: (operation: string) => fetch(url.origin + "/api/hosted-plugins/manage", { method: "POST", headers, body: JSON.stringify({ pluginId: id, operation }) }),
    };
  };
  try {
    await run("start");
    const first = await connect();
    const enabled = await first.manage("enable"); assert.equal(enabled.status, 200, await enabled.text());
    assert.ok(await readFile(lock));
    const before = await broker.active();
    const identity = { pluginId: id, sessionId: await first.session(), generation: before!.generation, mountId: "stop-editor" };
    const registration = await first.view({ ...identity, operation: "register", kind: "editor" });
    assert.equal(registration.status, 200);
    const view = { ...identity, viewToken: (await registration.json()).viewToken };
    await first.view({ ...view, operation: "change", dirty: true, busy: false });
    let stopResult: unknown;
    const refused = run("stop").catch(error => { stopResult = error; });
    const poll = await first.view({ ...view, operation: "poll", after: 0 });
    const freeze = (await poll.json()).commands.find((command: { type: string }) => command.type === "freeze");
    assert.ok(freeze, "launcher must request a flush before closing RPC input");
    await first.view({ ...view, operation: "ack", commandId: freeze.id, ok: false, error: "unsaved test drawing" });
    await refused;
    assert.ok(stopResult, "a failed flush must refuse stop rather than exit with a stale lock");
    assert.ok(await readFile(lock));
    assert.equal((await first.inventory()).phase, "active");
    assert.deepEqual(await broker.active(), before);
    await first.view({ ...view, operation: "change", dirty: false, busy: false });
    await first.view({ ...view, operation: "close" });
    await run("stop");
    await (await acquireStorageOwnership(broker.root, "runtime"))();
    assert.deepEqual(await broker.active(), before, "quit must retain enabled intent and drawing state");
    await run("start");
    const second = await connect(), card = await second.inventory();
    assert.equal(card.phase, "active"); assert.ok(card.documentUrl);
    const removed = await second.manage("uninstall"); assert.equal(removed.status, 200, await removed.text());
    assert.equal((await broker.active())?.enabled, false);
    await (await acquireStorageOwnership(broker.root, "runtime"))();
  } finally { await run("stop").catch(() => {}); await rm(root, { recursive: true, force: true }); }
});

for (const signal of ["SIGTERM", "SIGKILL"] as const) test(`real RPC host ${signal} permits cold start, upgrade activation and uninstall without lock repair`, { timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "hosted-launcher-crash-")), agentDir = join(root, "agent"), storage = join(agentDir, "pi-web/hosted");
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_WEBAPP_PI_CLI: cli, PI_WEBAPP_AUTO_OPEN: "0" };
  for (const key of ["PI_WEBAPP_RESTART_PORT", "PI_WEBAPP_RESTART_TOKEN", "PI_WEBAPP_LAUNCHER_NONCE", "PI_WEBAPP_PLUGIN_DEV_ROOTS"]) delete env[key as keyof typeof env];
  const run = (...args: string[]) => exec(process.execPath, [launcher, ...args], { cwd: root, env, timeout: 40_000 });
  const version = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version;
  const initial = integrationFixture(), upgraded = integrationFixture("0.1.1");
  const installer = new HostedPluginInstaller({ root: join(storage, "packages"), hostVersion: version });
  await installer.installArchive(id, initial.bytes, integrity(initial.bytes), "0.1.0");
  await writeFile(join(storage, "host-version.json"), JSON.stringify({ version }));
  const broker = new HostedStateBroker(join(storage, "data"), id);
  const connect = async () => {
    const state = JSON.parse(await readFile(join(agentDir, "pi-web/launcher.json"), "utf8")), url = new URL(state.url);
    const headers = { Authorization: `Bearer ${url.hash.slice(1)}`, Origin: url.origin, "Content-Type": "application/json" };
    return { state,
      inventory: async () => (await (await fetch(url.origin + "/api/hosted-plugins", { headers })).json()).plugins[0],
      manage: (operation: string) => fetch(url.origin + "/api/hosted-plugins/manage", { method: "POST", headers, body: JSON.stringify({ pluginId: id, operation }) }),
    };
  };
  try {
    await run("start");
    const first = await connect();
    const enabled = await first.manage("enable"); assert.equal(enabled.status, 200, await enabled.text());
    const before = await broker.active();
    const request = { requestId: "seed-drawing", generation: before!.generation, scope: { cwd: root, workspaceId: "fixture", sessionId: "fixture" }, kind: "action" as const, action: "seed", input: {} };
    const drawing = { text: "手改图稿", revision: 42 };
    await broker.call(request, "state.compareAndSwap", { key: "drawing", expectedRevision: 0, schema: 1, value: drawing });
    const lockBytes = await readFile(join(broker.root, "runtime.lock"));
    process.kill(first.state.piPid, signal);
    let exited = false;
    for (let n = 0; n < 500; n++) {
      try { await readFile(join(agentDir, "pi-web/launcher.json")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { exited = true; break; } throw error; }
      await delay(20);
    }
    assert.equal(exited, true, "launcher observes unexpected Pi exit");
    assert.deepEqual(await broker.active(), before, "abnormal exit must not change enabled intent or roll back state");
    const remainingFence = await readFile(join(broker.root, "runtime.lock")).catch(error => {
      if (signal === "SIGTERM" && error.code === "ENOENT") return null; throw error;
    });
    if (remainingFence) assert.deepEqual(remainingFence, lockBytes);
    // Stage a newer installed package through the real installer while stopped.
    // This verifies crash-safe upgrade activation, not a mocked registry download.
    await installer.installArchive(id, upgraded.bytes, integrity(upgraded.bytes), "0.1.1");
    await run("start");
    const second = await connect(), card = await second.inventory();
    assert.equal(card.phase, "active"); assert.ok(card.documentUrl);
    assert.equal((await broker.active())?.version, "0.1.0", "cold start retains the committed active version");
    const activated = await second.manage("enable"); assert.equal(activated.status, 200, await activated.text());
    const active = (await broker.active())!;
    assert.equal(active.version, "0.1.1");
    const retained = await broker.call({ ...request, requestId: "read-drawing", generation: active.generation }, "state.read", { key: "drawing" }) as { value: unknown; revision: number };
    assert.deepEqual(retained.value, drawing); assert.equal(retained.revision, 1);
    const removed = await second.manage("uninstall"); assert.equal(removed.status, 200, await removed.text());
    assert.equal((await broker.active())?.enabled, false);
    await (await acquireStorageOwnership(broker.root, "runtime"))();
  } finally { await run("stop").catch(() => {}); await rm(root, { recursive: true, force: true }); }
});
