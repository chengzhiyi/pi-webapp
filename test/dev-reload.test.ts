import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { createAgentSession, createEventBus, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import { invokeWebAction } from "@chengzhiyi/pi-web-protocol";
import { WorkspaceSessions } from "../extension/workspace-sessions.ts";

const launcher = fileURLToPath(new URL("../bin/pi-webapp.mjs", import.meta.url));
const extension = fileURLToPath(new URL("../dist/extension.js", import.meta.url));
const testPluginId = "fixture-dev-reload";

function extensionSource(version: number): string {
  return `export default function fixture(pi) {
    pi.events.on("pi-webapp:action:v1", request => {
      if (request?.pluginId !== ${JSON.stringify(testPluginId)}) return;
      const handlers = { version: () => ${version}, ${version === 1 ? "legacy" : "fresh"}: () => ${JSON.stringify(version === 1 ? "old-only" : "new-only")} };
      const handler = handlers[request.action];
      pi.events.emit("pi-webapp:action-response:v1", handler
        ? { requestId: request.requestId, ok: true, value: handler() }
        : { requestId: request.requestId, ok: false, error: "Unknown action: " + request.action });
    });
  }`;
}

test("real SDK reload evaluates changed extension handlers and detaches the old action listener", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-sdk-dev-reload-"));
  const cwd = join(directory, "workspace");
  const agentDir = join(directory, "agent");
  const extensionPath = join(directory, "fixture-extension.js");
  const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  t.after(async () => {
    session?.dispose();
    if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
    await rm(directory, { recursive: true, force: true });
  });
  await mkdir(cwd);
  await writeFile(extensionPath, extensionSource(1));
  const bus = createEventBus();
  const loader = new DefaultResourceLoader({ cwd, agentDir, noExtensions: true, additionalExtensionPaths: [extensionPath], eventBus: bus });
  await loader.reload();
  session = (await createAgentSession({ cwd, agentDir, resourceLoader: loader, sessionManager: SessionManager.create(cwd) })).session;
  await session.bindExtensions({ mode: "print", shutdownHandler: () => {} });
  const request = (action: string) => ({ pluginId: testPluginId, sessionId: session!.sessionManager.getSessionId(), action, requestId: crypto.randomUUID() });
  assert.equal(await invokeWebAction(bus, request("version")), 1);
  assert.equal(await invokeWebAction(bus, request("legacy")), "old-only");
  await writeFile(extensionPath, extensionSource(2));
  await session.reload();
  const versionRequest = request("version");
  const responses: unknown[] = [];
  const off = bus.on("pi-webapp:action-response:v1", response => {
    if ((response as { requestId?: string }).requestId === versionRequest.requestId) responses.push(response);
  });
  t.after(off);
  assert.equal(await invokeWebAction(bus, versionRequest), 2, "same-path SDK reload must execute the latest handler");
  assert.equal(responses.length, 1, "old and new action listeners must not answer simultaneously");
  await assert.rejects(invokeWebAction(bus, request("legacy")), /Unknown action/);
  assert.equal(await invokeWebAction(bus, request("fresh")), "new-only");
});

test("workspace runtime replacement reloads changed same-path plugin code instead of the cached factory", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workspace-code-reload-"));
  const cwd = join(root, "workspace"); const pkg = join(root, "plugin");
  const previousAgent = process.env.PI_CODING_AGENT_DIR;
  const previousDev = process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS = pkg;
  const host = new WorkspaceSessions(() => {}, () => undefined);
  try {
    await mkdir(cwd); await mkdir(join(pkg, "dist"), { recursive: true });
    await writeFile(join(pkg, "package.json"), JSON.stringify({ name: testPluginId, type: "module",
      pi: { extensions: ["./dist/extension.js"] }, piWebapp: { apiVersion: 1, client: "./dist/client.js" } }));
    await writeFile(join(pkg, "dist/client.js"), `export default {id:${JSON.stringify(testPluginId)},apiVersion:1,activate(){}}`);
    const path = join(pkg, "dist/extension.js");
    await writeFile(path, extensionSource(1));
    await host.open(cwd, "new");
    const sessionId = host.snapshot().sessionId;
    const invoke = (action: string) => host.invokePluginAction({ requestId: crypto.randomUUID(), pluginId: testPluginId, sessionId, action });
    assert.equal(await invoke("version"), 1);
    await writeFile(path, extensionSource(2));
    await host.reload();
    assert.equal(host.snapshot().sessionId, sessionId);
    assert.equal(await invoke("version"), 2);
    assert.equal(await invoke("fresh"), "new-only");
    await assert.rejects(invoke("legacy"), /Unknown action/);
  } finally {
    await host.dispose();
    if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgent;
    if (previousDev === undefined) delete process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS; else process.env.PI_WEBAPP_PLUGIN_DEV_ROOTS = previousDev;
    await rm(root, { recursive: true, force: true });
  }
});

function runLauncher(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [launcher, ...args], { env, encoding: "utf8", timeout: 15000 });
}

async function launcherFixture(t: TestContext, devName: string, rejectReload: boolean) {
  const directory = await mkdtemp(join(tmpdir(), "pi-launch-dev-reload-"));
  const pluginRoot = join(directory, "plugin");
  const inputPath = join(directory, "rpc-input.ndjson");
  const logPath = join(directory, "agent", "pi-web", "launcher.log");
  const env = { ...process.env, PATH: directory, PI_CODING_AGENT_DIR: join(directory, "agent"), PI_WEBAPP_AUTO_OPEN: "0",
    PI_WEBAPP_PLUGIN_DEV_ROOTS: pluginRoot, PI_TEST_RPC_INPUT: inputPath, PI_TEST_DEV_NAME: devName, PI_TEST_REJECT_RELOAD: rejectReload ? "1" : "0" };
  t.after(async () => {
    const stopped = runLauncher(["stop"], env);
    if (stopped.status !== 0) {
      try {
        const state = JSON.parse(await readFile(join(directory, "agent", "pi-web", "launcher.json"), "utf8"));
        for (const pid of [state.piPid, state.pid]) if (Number.isInteger(pid)) { try { process.kill(pid, "SIGTERM"); } catch { /* Already stopped. */ } }
      } catch { /* Startup already cleaned its state. */ }
    }
    await rm(directory, { recursive: true, force: true });
  });
  await mkdir(join(pluginRoot, "dist"), { recursive: true });
  await writeFile(join(pluginRoot, "dist", "extension.js"), "// initial fixture build\n");
  const fakePi = join(directory, "pi");
  await writeFile(fakePi, `#!${process.execPath}
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
if (process.argv.includes("--version")) { console.log("0.87.1"); process.exit(0); }
const args = process.argv.slice(2);
const extensionPath = args[args.indexOf("-e") + 1];
const reply = record => process.stdout.write(JSON.stringify(record) + "\\n");
const commands = [
  { name: "web:1", source: "extension", sourceInfo: { path: extensionPath } },
  { name: "web-dev-reload:9", source: "extension", sourceInfo: { path: "/unrelated/extension.js" } },
  { name: process.env.PI_TEST_DEV_NAME, source: "extension", sourceInfo: { path: extensionPath } },
];
createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  appendFileSync(process.env.PI_TEST_RPC_INPUT, JSON.stringify(request) + "\\n");
  if (request.type === "get_commands") {
    reply({ type: "response", id: request.id, command: "get_commands", success: true, data: { commands } });
  } else if (request.type === "prompt" && request.message === "/web:1") {
    reply({ type: "extension_ui_request", method: "notify", message: "pi-webapp: http://127.0.0.1:12345/#dev-reload-test" });
    reply({ type: "response", id: request.id, command: "prompt", success: true });
  } else if (request.type === "prompt") {
    const success = request.message === "/" + process.env.PI_TEST_DEV_NAME && process.env.PI_TEST_REJECT_RELOAD !== "1";
    reply({ type: "response", id: request.id, command: "prompt", success,
      ...(success ? {} : { error: "fixture-hot-reload-failed: backend retains old handlers" }) });
  }
});
`);
  await chmod(fakePi, 0o755);
  const started = runLauncher([], env);
  assert.equal(started.status, 0, started.stderr);
  // Starting successfully must not disable processing subsequent RPC responses.
  await writeFile(join(pluginRoot, "dist", "extension.js"), "// changed fixture build\n");
  return { inputPath, logPath, env };
}

async function waitFor<T>(read: () => Promise<T>, accepted: (value: T) => boolean, timeoutMs = 3000): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const value = await read(); if (accepted(value)) return value; } catch { /* Wait for file creation or a completed write. */ }
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
  return undefined;
}

async function reloadRequests(inputPath: string): Promise<{ id: string; message?: string }[]> {
  const records = (await readFile(inputPath, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  return records.filter(record => String(record.id).startsWith("dev-reload-"));
}

test("launcher discovers the source-matched dev reload alias before dispatching a changed build", { skip: process.platform === "win32" }, async (t) => {
  const fixture = await launcherFixture(t, "web-dev-reload:1", false);
  const requests = await waitFor(() => reloadRequests(fixture.inputPath), records => records.length > 0);
  assert.ok(requests?.length, "changing dist/extension.js must dispatch a dev reload command");
  assert.equal(requests[0].message, "/web-dev-reload:1", "resolve aliases from the command belonging to this extension, ignoring unrelated sources");
});

test("launcher logs a failed hot reload response received after startup readiness", { skip: process.platform === "win32" }, async (t) => {
  const fixture = await launcherFixture(t, "web-dev-reload", true);
  const requests = await waitFor(() => reloadRequests(fixture.inputPath), records => records.length > 0);
  assert.ok(requests?.length, "a failed response requires an actual dispatched hot reload request");
  const log = await waitFor(() => readFile(fixture.logPath, "utf8"), text => text.includes("fixture-hot-reload-failed"), 2000);
  assert.ok(log, "ready launcher must diagnose RPC reload rejection rather than silently retaining old handlers");
  assert.ok(log.includes("fixture-hot-reload-failed"));
  assert.match(log, /dev-reload-\d+|web-dev-reload/, "diagnostic must identify the failed reload request or command");
});
