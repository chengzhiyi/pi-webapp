import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { cp, mkdtemp, mkdir, readFile, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { HostedDevSources, HostedDevWatcher, devPluginsFromEnv, devSignature, inspectDevRoot, type DevSwitcher } from "../src/host/server/plugins/hosted/dev-plugins.ts";
import { HostedPluginInstaller } from "../src/host/server/plugins/hosted/installer.ts";
import { HostedPluginIntegration } from "../src/host/server/plugins/hosted/integration.ts";
import { DEFAULT_POLICIES, OFFICIAL_PLUGINS, type OfficialPlugin } from "../src/host/server/plugins/hosted/official-catalog.ts";
import { hostedAsset, sha256 } from "../src/host/server/plugins/hosted/resources.ts";
import { HostedPluginError } from "../src/host/server/plugins/hosted/errors.ts";
import { MemorySecretStore } from "../src/host/server/plugins/hosted/capabilities/secrets.ts";

const PLUGIN = new URL("../../pi-extensions/packages/excalidraw/", import.meta.url).pathname;
const EXCALIDRAW = "@chengzhiyi/pi-excalidraw";
/** A package that is not in the official catalog: in dev mode it describes itself, exactly like an official-plugins.json entry. */
const DEV_ID = "@example/pi-tasks";
const DEV_BLOCK = { name: "Tasks", description: { zh: "任务", en: "Tasks" }, policy: { tools: {}, readonlyActions: [], actions: ["get"], checkpointActions: ["get"],
  contribution: { entry: { label: "Tasks", description: { zh: "任务", en: "Tasks" }, kind: "workspace" }, panels: ["workspace"], artifactTools: [], toolViews: [], panelAlias: { prefix: "tasks:", kind: "workspace", title: "Tasks" } } } };
const code = (expected: string) => (e: unknown) => (e as { code?: string }).code === expected;
const tmp = async (t: { after(fn: () => Promise<void>): void }, cleanup = true) => { const root = await realpath(await mkdtemp(join(tmpdir(), "pi-dev-roots-"))); if (cleanup) t.after(() => rm(root, { recursive: true, force: true })); return root; };
const MANIFEST = { apiVersion: 2, hostRange: ">=0.1.0 <1.0.0", runtimeProtocol: 1, backend: { entry: "./dist/runtime.js" }, frontend: { document: "./dist/frame.html", controller: "./dist/frame.html" }, resourcesManifest: "./dist/resources.json", dataSchemaVersion: 1, supportedDataSchemas: [1], capabilities: ["state"] };
const CATALOG: OfficialPlugin[] = [{ id: DEV_ID, name: "Tasks", description: { zh: "", en: "" }, registry: "https://registry.npmjs.org", recommendedVersion: "0.1.0", requiredCapabilities: ["state"] }];
/** A minimal dev package directory (with the source-tree extras a real checkout has). */
async function pluginDir(root: string, options: { name?: string; hostRange?: string; label?: string; catalog?: unknown } = {}) {
  const dir = join(root, "plugin"); await mkdir(join(dir, "dist"), { recursive: true }); await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src", "index.ts"), "// source, never copied"); await writeFile(join(dir, "tsconfig.json"), "{}");
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: options.name ?? DEV_ID, version: "0.1.0", private: true, type: "module", piWebapp: { ...MANIFEST, hostRange: options.hostRange ?? MANIFEST.hostRange }, piWebappCatalog: "catalog" in options ? options.catalog : DEV_BLOCK }));
  await writeDist(dir, options.label ?? "one");
  return dir;
}
async function writeDist(dir: string, label: string, mutate: (files: Array<{ path: string; bytes: number; sha256: string; mime: string }>) => void = () => {}) {
  await mkdir(join(dir, "dist"), { recursive: true });
  const files = [{ path: "runtime.js", content: `export const createRuntime = () => ({describe:()=>({tools:[]}),health:()=>true,invoke:()=>"${label}"})`, mime: "text/javascript" }, { path: "frame.html", content: `<!doctype html><html>${label}</html>`, mime: "text/html" }];
  for (const f of files) await writeFile(join(dir, "dist", f.path), f.content);
  const listed = files.map(f => ({ path: `./dist/${f.path}`, bytes: Buffer.byteLength(f.content), sha256: sha256(f.content), mime: f.mime }));
  mutate(listed);
  await writeFile(join(dir, "dist", "resources.json"), JSON.stringify({ version: 1, files: listed }));
}
const installer = (root: string) => new HostedPluginInstaller({ root, hostVersion: "0.1.39", catalog: CATALOG });

test("dev directory install: validated snapshot, fresh version per content, unchanged content reuses the version", async t => {
  const root = await tmp(t), dir = await pluginDir(root), inst = installer(join(root, "store"));
  const first = await inst.installDevDirectory(DEV_ID, dir);
  assert.match(first.version, /^0\.1\.\d+$/); assert.notEqual(first.version, "0.1.0");
  assert.ok(!existsSync(join(first.root, "src")) && !existsSync(join(first.root, "tsconfig.json")), "only package.json + dist are snapshotted");
  const again = await inst.installDevDirectory(DEV_ID, dir);
  assert.equal(again.version, first.version); assert.equal(again.digest, first.digest);
  await writeDist(dir, "two");
  const second = await inst.installDevDirectory(DEV_ID, dir);
  assert.ok(Number(second.version.split(".")[2]) > Number(first.version.split(".")[2]), "strictly increasing");
  assert.deepEqual((await inst.inventory()).versions[DEV_ID]!.map(v => v.version), [first.version, second.version]);
  assert.equal((await inst.load(DEV_ID, first.version)).digest, first.digest, "the earlier snapshot stays intact and loadable");
  await writeDist(dir, "one");
  assert.notEqual((await inst.installDevDirectory(DEV_ID, dir)).version, first.version, "going back is a new version: installed versions stay immutable");
});

test("a freshly installed package is servable even when the data directory is reached through a symlink", async t => {
  const root = await tmp(t), dir = await pluginDir(root); await symlink(root, join(tmpdir(), `pi-dev-link-${process.pid}`));
  const link = join(tmpdir(), `pi-dev-link-${process.pid}`); t.after(() => rm(link, { force: true }));
  const pkg = await installer(join(link, "store")).installDevDirectory(DEV_ID, dir);
  assert.ok((await hostedAsset(pkg, "dist/frame.html", pkg.digest))?.bytes.length);
});

test("dev directory install keeps every package check", async t => {
  const root = await tmp(t), inst = installer(join(root, "store"));
  const reject = async (label: string, prepare: (dir: string) => Promise<void>, expected: string, options: Parameters<typeof pluginDir>[1] = {}) => {
    const dir = await pluginDir(join(await mkdtemp(join(root, "case-")), "x") && await mkdtemp(join(root, "case-")), options); await prepare(dir);
    await assert.rejects(inst.installDevDirectory(DEV_ID, dir), code(expected), label);
  };
  await reject("resource hash mismatch", dir => writeDist(dir, "x", files => { files[0]!.sha256 = "0".repeat(64); }), "invalid_package");
  await reject("undeclared dist file", dir => writeFile(join(dir, "dist", "extra.js"), "x"), "invalid_package");
  await reject("symlink in dist", async dir => { await symlink("/etc/hosts", join(dir, "dist", "link.js")); }, "invalid_package");
  await reject("wrong identity", async () => {}, "invalid_package", { name: "@someone/else" });
  await reject("host range", async () => {}, "incompatible_plugin", { hostRange: ">=5.0.0" });
  await reject("not built yet", dir => rm(join(dir, "dist"), { recursive: true }), "dist_missing");
  await reject("capabilities", async dir => { const p = JSON.parse(await readFile(join(dir, "package.json"), "utf8")); p.piWebapp.capabilities = []; await writeFile(join(dir, "package.json"), JSON.stringify(p)); }, "incompatible_plugin");
  assert.deepEqual((await inst.inventory()).versions, {}, "nothing from a rejected directory is installed");
});

test("production paths are unchanged: archives still need publisher SRI, and dev mode is off without an explicit opt-in", async t => {
  const root = await tmp(t), dir = await pluginDir(root), inst = installer(join(root, "store"));
  await inst.installDevDirectory(DEV_ID, dir);
  // A tgz still needs a real SHA-512 integrity; the dev directory's synthetic one is not accepted anywhere else.
  await assert.rejects(inst.installArchive(DEV_ID, Buffer.from("not a package"), "sha512-" + "A".repeat(86) + "==", "0.1.1"), code("integrity_mismatch"));
  await assert.rejects(inst.installArchive(DEV_ID, Buffer.from("x"), "sha1-abc", "0.1.1"), code("invalid_integrity"));
  await assert.rejects(inst.installDevDirectory("@someone/else", dir), code("unknown_plugin"), "ids outside the catalog are never trusted");
  assert.equal(devPluginsFromEnv("").archives.size, 0);
  assert.equal(new HostedDevSources({ env: {}, configPath: join(root, "none.json") }).enabled, false, "no env and no config file means dev mode is off");
});

test("diagnostics explain every kind of bad dev configuration", async t => {
  const root = await tmp(t), good = await pluginDir(root), configPath = join(root, "hosted-dev.json");
  const bad = async (name: string, files: Record<string, string>) => { const d = join(root, name); await mkdir(d, { recursive: true }); for (const [f, c] of Object.entries(files)) await writeFile(join(d, f), c); return d; };
  const notAPlugin = await bad("unknown", { "package.json": JSON.stringify({ name: "@x/y", piWebapp: MANIFEST }) });
  const badManifest = await bad("manifest", { "package.json": JSON.stringify({ name: DEV_ID, piWebapp: { apiVersion: 1 } }) });
  const notJson = await bad("json", { "package.json": "{" });
  const noPackage = await bad("empty", {});
  const sources = new HostedDevSources({ env: { PI_WEBAPP_HOSTED_DEV_ROOTS: [join(root, "missing"), noPackage, notJson, notAPlugin, badManifest, good].join(":") }, configPath });
  const messages = sources.notices().map(n => n.message);
  assert.equal(sources.notices().length, 5, messages.join("\n"));
  assert.match(messages[0]!, /missing: directory does not exist/);
  assert.match(messages[1]!, /package\.json not found/); assert.match(messages[2]!, /not valid JSON/);
  assert.match(messages[3]!, /@x\/y is not an official plugin \(official: @chengzhiyi\/pi-excalidraw, @chengzhiyi\/pi-pencil\)\. Describe it in package\.json "piWebappCatalog"/); assert.match(messages[4]!, /not a valid hosted v2 manifest/);
  assert.deepEqual([...sources.roots], [[DEV_ID, good]]); assert.equal(sources.enabled, true);
  assert.deepEqual(sources.catalog.map(p => [p.id, p.name, p.official]), [[DEV_ID, "Tasks", false]], "self-described, never labelled official");
  assert.deepEqual(sources.policies.get(DEV_ID)?.actions, ["get"]);

  await writeFile(configPath, JSON.stringify({ roots: ["relative/path", 7] }));
  const file = new HostedDevSources({ env: {}, configPath });
  assert.equal(file.enabled, true); assert.equal(file.notices().length, 2); assert.match(file.notices()[0]!.message, /absolute path/);
  await writeFile(configPath, "{ nope"); assert.match(new HostedDevSources({ env: {}, configPath }).notices()[0]!.message, /cannot read dev configuration/);
  await writeFile(configPath, JSON.stringify({ wrong: true })); assert.match(new HostedDevSources({ env: {}, configPath }).notices()[0]!.message, /roots/);

  const archive = devPluginsFromEnv(`@x/y=${join(root, "a.tgz")};${EXCALIDRAW}=${join(root, "a.txt")};${EXCALIDRAW}=${join(root, "gone.tgz")};junk`);
  assert.equal(archive.archives.size, 0);
  assert.match(archive.notices.map(n => n.message).join("\n"), /"@x\/y" is not an official plugin[\s\S]*PI_WEBAPP_HOSTED_DEV_ROOTS[\s\S]*not a \.tgz[\s\S]*archive not found[\s\S]*not <id>=<path\.tgz>/);
});

test("an official plugin can be developed from a local directory or archive without joining the dev catalog", async t => {
  const root = await tmp(t), configPath = join(root, "hosted-dev.json");
  const dir = await pluginDir(root, { name: "@chengzhiyi/pi-excalidraw" });
  const sources = new HostedDevSources({ env: {}, configPath });
  // Added after startup: it is already in the host catalog, so it applies live instead of asking for a restart.
  await writeFile(configPath, JSON.stringify({ roots: [dir] })); sources.refresh();
  assert.deepEqual([...sources.roots], [["@chengzhiyi/pi-excalidraw", dir]]);
  assert.deepEqual(sources.notices(), []);
  assert.equal(sources.catalog.some(p => p.id === "@chengzhiyi/pi-excalidraw"), false);
  await writeFile(join(root, "x.tgz"), "");
  const archive = devPluginsFromEnv(`@chengzhiyi/pi-excalidraw=${join(root, "x.tgz")}`);
  assert.deepEqual(archive.notices, []);
  assert.equal(archive.archives.get("@chengzhiyi/pi-excalidraw"), join(root, "x.tgz"));
});

test("a root added to the config after startup is reported, not silently ignored; edits to known plugins apply live", async t => {
  const root = await tmp(t), configPath = join(root, "hosted-dev.json"), dir = await pluginDir(root);
  const sources = new HostedDevSources({ env: {}, configPath });
  assert.equal(sources.enabled, false); assert.equal(sources.roots.size, 0);
  await writeFile(configPath, JSON.stringify({ roots: [dir] })); sources.refresh();
  assert.equal(sources.roots.size, 0); assert.match(sources.notices()[0]!.message, /Restart pi-webapp once/);
  const started = new HostedDevSources({ env: {}, configPath });
  assert.equal(started.roots.get(DEV_ID), dir);
  const moved = await pluginDir(await mkdtemp(join(root, "moved-"))); await writeFile(configPath, JSON.stringify({ roots: [moved] })); started.refresh();
  assert.equal(started.roots.get(DEV_ID), moved, "same plugin, new directory: picked up live");
  await writeFile(configPath, JSON.stringify({ roots: [] })); started.refresh();
  assert.equal(started.roots.size, 0, "removing a root returns the plugin to the registry path");
});

test("a self-described dev package is validated like an official entry, and a policy edit asks for a restart", async t => {
  const root = await tmp(t), configPath = join(root, "hosted-dev.json");
  const reject = async (catalog: unknown, pattern: RegExp) => {
    const dir = await pluginDir(await mkdtemp(join(root, "case-")), { catalog });
    const sources = new HostedDevSources({ env: { PI_WEBAPP_HOSTED_DEV_ROOTS: dir }, configPath });
    assert.equal(sources.roots.size, 0); assert.equal(sources.catalog.length, 0);
    assert.match(sources.notices()[0]!.message, pattern);
  };
  await reject(undefined, /not an official plugin/);
  await reject({ ...DEV_BLOCK, id: "@chengzhiyi/pi-excalidraw" }, /must not set id or registry/);
  await reject({ ...DEV_BLOCK, official: true }, /piWebappCatalog\.official is not a known field/);
  await reject({ ...DEV_BLOCK, icon: "github" }, /piWebappCatalog\.icon must be one of drawing/);
  await reject({ ...DEV_BLOCK, policy: { ...DEV_BLOCK.policy, checkpointActions: ["sync"] } }, /checkpointActions lists "sync", which is not one of its actions/);
  await reject({ ...DEV_BLOCK, policy: { ...DEV_BLOCK.policy, secrets: { token: { provider: "gitlab", scope: "api", createUrl: "https://gitlab.com/x" } } } }, /provider must be "github"/);

  const dir = await pluginDir(join(root, "live"));
  await writeFile(configPath, JSON.stringify({ roots: [dir] }));
  const sources = new HostedDevSources({ env: {}, configPath });
  assert.deepEqual(sources.notices(), []);
  const pkgPath = join(dir, "package.json"), pkg = JSON.parse(await readFile(pkgPath, "utf8"));
  pkg.piWebappCatalog.policy.actions = ["get", "list"]; await writeFile(pkgPath, JSON.stringify(pkg)); sources.refresh();
  assert.match(sources.notices()[0]!.message, /policy changed; restart pi-webapp once/);
  assert.deepEqual(sources.policies.get(DEV_ID)?.actions, ["get"], "the running host keeps the policy it started with");
  assert.equal(sources.roots.get(DEV_ID), dir, "code still reloads live");
});

test("watcher applies a change once its files settle, never twice, and reports failures instead of retrying them", async t => {
  const root = await tmp(t), dir = await pluginDir(root), updates: string[] = [];
  let behavior: "ok" | "fail" | "busy" | "saving" | "barrier" | "parked" | "uninstalled" = "ok";
  const retries: string[] = [];
  const sources = new HostedDevSources({ env: { PI_WEBAPP_HOSTED_DEV_ROOTS: dir }, configPath: join(root, "none.json") });
  const switcher: DevSwitcher = { update: async id => {
    updates.push(id);
    if (behavior === "fail") throw new HostedPluginError("invalid_package", "Resource integrity mismatch");
    if (behavior === "busy") throw new HostedPluginError("storage_busy", "busy");
    if (behavior === "saving") throw new HostedPluginError("view_barrier", "Close editors before updating; Pending views: editor:m (busy)", { status: 409, reason: "view_busy" });
    if (behavior === "barrier") throw new HostedPluginError("view_barrier", "Close editors before updating; Pending views: editor:m", { status: 409 });
    if (behavior === "uninstalled") throw new HostedPluginError("not_installed", "Install the plugin first");
    if (behavior === "parked") return { plugins: [{ pluginId: id, name: "Tasks", official: false, installed: true, enabled: true, phase: "pending", version: "0.1.0", pendingVersion: "0.1.9" }] };
    return { plugins: [{ pluginId: id, name: "Tasks", official: false, installed: true, enabled: true, phase: "active", version: `0.1.${updates.length}` }] };
  }, retry: async id => {
    retries.push(id);
    if (behavior === "parked") return { plugins: [{ pluginId: id, name: "Tasks", official: false, installed: true, enabled: true, phase: "pending", version: "0.1.0", pendingVersion: "0.1.9" }] };
    return { plugins: [{ pluginId: id, name: "Tasks", official: false, installed: true, enabled: true, phase: "active", version: "0.1.9" }] };
  } };
  const statusPath = join(root, "status", "hosted-dev-status.json"), logs: string[] = [];
  const watcher = new HostedDevWatcher({ sources, switcher, statusPath, log: m => logs.push(m) });
  const touch = async (label: string) => { await writeDist(dir, label); const future = new Date(Date.now() + updates.length * 1000 + 5000); await utimes(join(dir, "dist", "resources.json"), future, future); };
  await watcher.tick(); assert.equal(updates.length, 0, "first sight only records the signature");
  await watcher.tick(); assert.equal(updates.length, 1, "unchanged on the next poll: settled, applied");
  await watcher.tick(); await watcher.tick(); assert.equal(updates.length, 1, "no change -> no more switches");
  assert.equal(watcher.info().sources[0]!.state, "synced");
  const status = JSON.parse(await readFile(statusPath, "utf8"));
  assert.equal(status.plugins[DEV_ID].state, "synced"); assert.deepEqual(status.catalog, [DEV_ID]); assert.equal(status.pid, process.pid);

  await touch("two"); await watcher.tick(); assert.equal(updates.length, 1, "a changing file waits for the next poll (debounce)");
  await touch("three"); await watcher.tick(); assert.equal(updates.length, 1); await watcher.tick(); assert.equal(updates.length, 2);

  await rm(join(dir, "dist"), { recursive: true }); await watcher.tick(); await watcher.tick();
  assert.equal(updates.length, 2); assert.equal(watcher.info().sources[0]!.state, "waiting-build", "a missing dist is a build in progress, not an error");

  behavior = "fail"; await writeDist(dir, "four"); await watcher.tick(); await watcher.tick();
  assert.equal(updates.length, 3); let source = watcher.info().sources[0]!;
  assert.equal(source.state, "error"); assert.match(source.message!, /Resource integrity mismatch \(invalid_package\)/);
  await watcher.tick(); await watcher.tick(); assert.equal(updates.length, 3, "a rejected build is not retried until the files change again");
  behavior = "ok"; await touch("five"); await watcher.tick(); await watcher.tick();
  assert.equal(updates.length, 4); assert.equal(watcher.info().sources[0]!.state, "synced", "fixing the build recovers by itself");

  behavior = "busy"; await touch("six"); await watcher.tick(); await watcher.tick(); await watcher.tick();
  assert.ok(updates.length >= 6, "transient busy errors are retried on the next poll");
  // An open editor mid-save: shown as pending (not an error) and retried on each poll until it switches.
  behavior = "saving"; await touch("saving"); await watcher.tick(); const before = updates.length; await watcher.tick();
  source = watcher.info().sources[0]!;
  assert.equal(source.state, "pending"); assert.match(source.message!, /saving/);
  await watcher.tick(); assert.ok(updates.length > before, "a view_busy refusal is retried on the next poll");
  behavior = "ok"; await watcher.tick(); assert.equal(watcher.info().sources[0]!.state, "synced", "it switches as soon as the save finishes");
  // A switch parked as pending (an editor was mid-save at the first check) is applied again on each poll
  // through retry, without reinstalling, and lands once nothing is in flight.
  behavior = "parked"; await touch("parked"); await watcher.tick(); await watcher.tick();
  assert.equal(watcher.info().sources[0]!.state, "pending");
  const updatesWhileParked = updates.length; await watcher.tick(); await watcher.tick();
  assert.equal(updates.length, updatesWhileParked, "no reinstall while parked"); assert.ok(retries.length >= 2, "the parked build is retried on each poll");
  behavior = "ok"; await watcher.tick();
  assert.equal(watcher.info().sources[0]!.state, "synced"); assert.equal(watcher.info().sources[0]!.version, "0.1.9");
  const settled = retries.length; await watcher.tick(); await watcher.tick(); assert.equal(retries.length, settled, "nothing more to retry once it switched");
  // A barrier that is not just in-flight work (an editor open outside immediate mode) is still reported, once.
  behavior = "barrier"; await touch("barrier"); await watcher.tick(); await watcher.tick(); const refused = updates.length;
  assert.equal(watcher.info().sources[0]!.state, "error"); await watcher.tick(); await watcher.tick(); assert.equal(updates.length, refused);
  behavior = "uninstalled"; await touch("seven"); await watcher.tick(); await watcher.tick();
  assert.equal(watcher.info().sources[0]!.state, "not-installed");
  assert.ok(logs.some(l => /synced/.test(l)) && logs.some(l => /error/.test(l)));
  assert.equal(await devSignature(join(root, "does-not-exist")), null);
});

test("failed dev switches never exhaust the retained-version budget: unreferenced builds are collected before the next install", async t => {
  const root = await tmp(t), dir = await pluginDir(root), store = join(root, "hosted", "packages");
  const pkgPath = join(dir, "package.json"), pkg = JSON.parse(await readFile(pkgPath, "utf8"));
  pkg.piWebapp.capabilities = ["state", "panels", "scheduler", "network", "secrets", "sessions"]; await writeFile(pkgPath, JSON.stringify(pkg));
  // Sixteen builds left behind by switches that never completed (nothing references them).
  const sources = new HostedDevSources({ env: { PI_WEBAPP_HOSTED_DEV_ROOTS: dir }, configPath: join(root, "none.json") });
  const inst = new HostedPluginInstaller({ root: store, hostVersion: "0.1.39", catalog: [...OFFICIAL_PLUGINS, ...sources.catalog] });
  for (let i = 0; i < 16; i++) { await writeDist(dir, `left-${i}`); await inst.installDevDirectory(DEV_ID, dir); }
  assert.equal((await inst.inventory()).versions[DEV_ID]!.length, 16);
  await writeDist(dir, "next");
  const integration = new HostedPluginIntegration({ root: join(root, "hosted"), hostVersion: "0.1.39", workerEntry: join(root, "unused-worker.mjs"), ownerId: "o", catalog: [...OFFICIAL_PLUGINS, ...sources.catalog], policies: new Map([...DEFAULT_POLICIES, ...sources.policies]), devRoots: sources.roots, devArchives: sources.archives,
    capabilities: { secrets: new MemorySecretStore(), resolve: async () => [], fetch: (async () => new Response("{}")) as unknown as typeof fetch },
    scheduledScope: () => ({ cwd: root, workspaceId: "w", sessionId: "scheduler" }), scheduleTimers: { setInterval: () => 1, clearInterval: () => {} }, resolveSession: () => null });
  t.after(() => integration.shutdown());
  await integration.start();
  const inventory = await integration.handlers.manage({ pluginId: DEV_ID, operation: "install" } as never) as { plugins: Array<{ pluginId: string; version?: string }> };
  const installed = inventory.plugins.find(p => p.pluginId === DEV_ID)!.version!;
  const left = (await inst.inventory()).versions[DEV_ID]!.map(v => v.version);
  assert.ok(left.includes(installed), "the new build is installed");
  assert.ok(left.length <= 2, `stale builds were collected (left: ${left.join(", ")})`);
});

const built = existsSync(join(PLUGIN, "dist/resources.json"));
test("integration: saving the plugin's dist switches the live plugin without any manual update", { skip: !built && "build packages/excalidraw first (pnpm --filter @chengzhiyi/pi-excalidraw build)", timeout: 60_000 }, async t => {
  const root = await tmp(t, false), workerEntry = join(root, "worker.mjs"), dir = join(root, "excalidraw");
  await build({ entryPoints: [new URL("../src/host/server/plugins/hosted/worker-entry.ts", import.meta.url).pathname], outfile: workerEntry, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
  await mkdir(dir); await cp(join(PLUGIN, "dist"), join(dir, "dist"), { recursive: true }); await cp(join(PLUGIN, "package.json"), join(dir, "package.json"));
  const sources = new HostedDevSources({ env: { PI_WEBAPP_HOSTED_DEV_ROOTS: dir }, configPath: join(root, "none.json") });
  const statusPath = join(root, "hosted-dev-status.json"), scope = (sessionId: string) => ({ cwd: root, workspaceId: "w", sessionId });
  const integration = new HostedPluginIntegration({ root: join(root, "hosted"), hostVersion: "0.1.39", workerEntry, ownerId: "o", catalog: [...OFFICIAL_PLUGINS, ...sources.catalog], devRoots: sources.roots, devArchives: sources.archives,
    dev: sources, devStatusPath: statusPath, devPollMs: 40, capabilities: { secrets: new MemorySecretStore(), resolve: async () => ["140.82.112.5"], fetch: (async () => new Response("{}")) as unknown as typeof fetch },
    scheduledScope: () => scope("scheduler"), scheduleTimers: { setInterval: () => 1, clearInterval: () => {} }, resolveSession: id => id === "chat" ? scope("chat") : null });
  t.after(async () => { integration.adapter.thaw(); await integration.shutdown(); await rm(root, { recursive: true, force: true }); });
  await integration.start();
  const card = async () => (await integration.inventory()).plugins.find(p => p.pluginId === EXCALIDRAW)!;
  // Excalidraw is a large package: under a parallel full-suite run a switch holds the storage lock for seconds, so a poll may see storage_busy.
  const until = async (what: string, ok: () => Promise<boolean>) => { for (let i = 0; i < 500; i++) { if (await ok().catch(error => { if ((error as { code?: string }).code === "storage_busy") return false; throw error; })) return; await new Promise(r => setTimeout(r, 40)); } assert.fail(`timed out waiting for ${what}`); };
  await until("the watcher to notice the plugin is not installed", async () => (await integration.inventory()).dev?.sources[0]?.state === "not-installed");
  assert.equal((await card()).updateDiagnostic, undefined, "polling an uninstalled plugin must not leave a failed-update diagnostic on its card");
  await integration.handlers.manage({ pluginId: EXCALIDRAW, operation: "install" } as never);
  await integration.handlers.manage({ pluginId: EXCALIDRAW, operation: "enable" } as never);
  const first = await card(); assert.equal(first.enabled, true); assert.equal(first.phase, "active");
  await until("the watcher to settle on the installed source", async () => (await integration.inventory()).dev?.sources[0]?.state === "synced");
  assert.equal((await card()).version, first.version, "unchanged dist: nothing is switched");

  const css = join(dir, "dist", "frame.css"), manifestPath = join(dir, "dist", "resources.json");
  const edit = async (content: string, tamper = false) => {
    const next = Buffer.from(content); await writeFile(css, next);
    const resources = JSON.parse(await readFile(manifestPath, "utf8")); const entry = resources.files.find((f: { path: string }) => f.path === "./dist/frame.css");
    entry.bytes = next.length; entry.sha256 = tamper ? "0".repeat(64) : sha256(next); await writeFile(manifestPath, JSON.stringify(resources));
  };
  await edit((await readFile(css, "utf8")) + "\n/* edited by the developer */\n");
  await until("the automatic switch", async () => { const c = await card(); return c.version !== first.version && c.phase === "active" && !c.pendingVersion; });
  const second = await card(); assert.equal(second.enabled, true); assert.ok(second.generation! > first.generation!, "a new runtime generation was published");
  await until("the watcher to record the switch", async () => (await integration.inventory()).dev?.sources[0]?.version === second.version);
  await until("the status file", async () => JSON.parse(await readFile(statusPath, "utf8")).plugins[EXCALIDRAW].version === second.version);
  assert.match(second.documentUrl!, /frame\.html$/);
  const status = JSON.parse(await readFile(statusPath, "utf8")); assert.equal(status.plugins[EXCALIDRAW].state, "synced"); assert.equal(status.plugins[EXCALIDRAW].version, second.version);

  await edit("body{}", true);
  await until("the broken build to be reported", async () => (await integration.inventory()).dev?.sources[0]?.state === "error");
  assert.equal((await card()).version, second.version, "a broken build never replaces the running plugin");
  assert.match((await integration.inventory()).dev!.sources[0]!.message!, /integrity/i);
  assert.equal((await card()).updateDiagnostic?.status, "failed");
  await edit("body{color:red}");
  await until("recovery after the fix", async () => { const c = await card(); return c.version !== second.version && c.phase === "active"; });
  assert.equal((await card()).updateDiagnostic?.status, "up-to-date", "a successful sync replaces the earlier failed diagnostic");
});

test("without developer opt-in the catalog carries no dev information", async t => {
  const root = await tmp(t, false);
  const integration = new HostedPluginIntegration({ root: join(root, "hosted"), hostVersion: "0.1.39", workerEntry: join(root, "worker.mjs"), ownerId: "o", resolveSession: () => null });
  t.after(async () => { integration.adapter.thaw(); await integration.shutdown(); await rm(root, { recursive: true, force: true }); });
  await integration.start();
  assert.equal("dev" in (await integration.inventory()), false);
});

test("a dev root without package.json is named a parent folder only when it holds packages", async t => {
  const root = await tmp(t), source = "hosted-dev.json";
  await pluginDir(root);
  const parent = inspectDevRoot({ path: root, source }).notice!.message;
  assert.match(parent, /looks like a parent folder \(packages inside: plugin\)/);
  const leftover = join(root, "leftover"); await mkdir(join(leftover, "dist"), { recursive: true }); await mkdir(join(leftover, "node_modules", "dep"), { recursive: true });
  await writeFile(join(leftover, "node_modules", "dep", "package.json"), "{}");
  const stale = inspectDevRoot({ path: leftover, source }).notice!.message;
  assert.match(stale, /the folder is not a package \(is the right branch checked out\?\)/);
  assert.doesNotMatch(stale, /parent/);
});
