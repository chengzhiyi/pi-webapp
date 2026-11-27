import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { installFileManagerIpc } from "../file-manager.mjs";

const token = "a".repeat(32);
const backendUrl = `http://127.0.0.1:4567/#${token}`;
const sessionTarget = { sessionId: "current", path: "src/main.ts", kind: "file" };
const workspaceTarget = { workspaceId: "registered", path: "", kind: "directory" };
const failed = { ok: false, reason: "failed" };
const notFound = { ok: false, reason: "not-found" };

function setup(cwd, workspace, options = {}) {
  const handlers = new Map();
  const calls = [], requests = [];
  const frame = { url: backendUrl };
  const contents = { mainFrame: frame, isDestroyed: () => false };
  const state = { contents, backendUrl };
  const shell = {
    showItemInFolder: path => calls.push(["select", path]),
    openPath: async path => { calls.push(["open", path]); return ""; },
  };
  installFileManagerIpc({
    platform: process.platform === "win32" ? "win32" : "darwin",
    ipcMain: { handle: (channel, fn) => { handlers.set(channel, fn); } },
    shell, getContents: () => state.contents, getBackendUrl: () => state.backendUrl, macFolder: async () => true,
    fetcher: async (url, init) => {
      assert.equal(url.origin, new URL(backendUrl).origin);
      assert.equal(url.hash, "");
      assert.equal(init.method, "GET");
      assert.equal(init.headers.Authorization, `Bearer ${token}`);
      assert.equal(init.redirect, "error");
      requests.push(url.pathname);
      if (url.pathname === "/api/session") return Response.json({ sessionId: "current", cwd });
      assert.equal(url.pathname, "/api/workspaces");
      return Response.json({ items: [{ id: "registered", path: workspace }, { id: "gone", path: workspace, available: false }] });
    },
    ...options,
  });
  const event = { sender: contents, senderFrame: frame };
  return { handler: handlers.get("file-manager:show"), handlers, calls, contents, state, frame, requests, shell,
    show: (input, source = event) => handlers.get("file-manager:show")(source, input),
    list: input => handlers.get("file-manager:list-apps")(event, input),
    open: (input, id) => handlers.get("file-manager:open-with")(event, input, id) };
}

async function fixture(t) {
  const temp = await mkdtemp(join(tmpdir(), "pi-file-manager-"));
  t.after(() => rm(temp, { force: true, recursive: true }));
  const root = await realpath(temp);
  const cwd = join(root, "worktree"), workspace = join(root, "worktree-extra");
  await mkdir(join(cwd, "src"), { recursive: true });
  await mkdir(workspace);
  await writeFile(join(cwd, "src", "main.ts"), "");
  await writeFile(join(workspace, "outside.ts"), "");
  return { cwd, workspace };
}

test("uses the authenticated current session cwd and registered workspace root independently", async t => {
  const { cwd, workspace } = await fixture(t);
  const { show, calls, requests } = setup(cwd, workspace);
  assert.deepEqual(await show(sessionTarget), { ok: true });
  assert.deepEqual(await show({ ...sessionTarget, path: "src", kind: "directory" }), { ok: true });
  assert.deepEqual(await show(workspaceTarget), { ok: true });
  assert.deepEqual(calls, [["select", join(cwd, "src", "main.ts")], ["open", join(cwd, "src")], ["open", workspace]]);
  assert.deepEqual(requests, ["/api/session", "/api/session", "/api/workspaces"]);
});

test("fails closed for stale sessions, unknown workspaces, missing targets and type mismatches", async t => {
  const { cwd, workspace } = await fixture(t);
  const { show, calls } = setup(cwd, workspace);
  assert.deepEqual(await show({ ...sessionTarget, sessionId: "previous" }), notFound);
  for (const workspaceId of ["gone", "unknown"]) assert.deepEqual(await show({ ...workspaceTarget, workspaceId }), notFound);
  assert.deepEqual(await show({ ...sessionTarget, path: "missing.ts" }), notFound);
  assert.deepEqual(await show({ ...sessionTarget, path: "src" }), notFound);
  assert.deepEqual(await show({ ...sessionTarget, kind: "directory" }), notFound);
  assert.deepEqual(calls, []);
});

test("rejects untrusted senders, paths and non-root sidebar requests before calling the backend", async () => {
  const { show, contents, frame, calls, requests } = setup();
  assert.deepEqual(await show(sessionTarget, { sender: {}, senderFrame: frame }), failed);
  assert.deepEqual(await show(sessionTarget, { sender: contents, senderFrame: { url: frame.url } }), failed);
  for (const url of ["https://external.example/", "http://127.0.0.1:4567/other", "http://127.0.0.1:4567/?query"]) {
    frame.url = url;
    assert.deepEqual(await show(sessionTarget), failed);
  }
  frame.url = backendUrl;
  for (const path of ["/tmp/file", "../file", "src/../file", "src//file", "./file", "a\\b", "\\\\server\\share", "C:file", "C:/file", "src/\0file"]) {
    assert.deepEqual(await show({ ...sessionTarget, path }), failed, path);
  }
  for (const target of [null, {}, { ...workspaceTarget, path: "child" }, { ...workspaceTarget, kind: "file" },
    { ...sessionTarget, workspaceId: "registered" }, { ...sessionTarget, kind: "other" }]) {
    assert.deepEqual(await show(target), failed);
  }
  assert.deepEqual(requests, []);
  assert.deepEqual(calls, []);
});

test("does not dispatch if the frame, window, or backend changes during lookup", async t => {
  const { cwd, workspace } = await fixture(t);
  for (const change of [app => { app.frame.url = "https://external.example/"; },
    app => { app.state.contents = undefined; }, app => { app.state.backendUrl = backendUrl.replace("4567", "4568"); }]) {
    const app = setup(cwd, workspace, { fetcher: async () => {
      change(app);
      return Response.json({ sessionId: "current", cwd });
    } });
    assert.deepEqual(await app.show(sessionTarget), failed);
    assert.deepEqual(app.calls, []);
  }
});

test("resolves in-root links but rejects escaping directory symlinks or Windows junctions", async t => {
  const { cwd, workspace } = await fixture(t);
  const type = process.platform === "win32" ? "junction" : "dir";
  await symlink(workspace, join(cwd, "outside"), type);
  await symlink(join(cwd, "src"), join(cwd, "inside"), type);
  const { show, calls } = setup(cwd, workspace);
  assert.deepEqual(await show({ ...sessionTarget, path: "outside/outside.ts" }), failed);
  assert.deepEqual(await show({ ...sessionTarget, path: "outside", kind: "directory" }), failed);
  assert.deepEqual(await show({ ...sessionTarget, path: "inside/main.ts" }), { ok: true });
  assert.deepEqual(calls, [["select", join(cwd, "src", "main.ts")]]);
});

test("Windows rejects device, alternate stream and special shell paths, even with mocked Windows filesystem", async () => {
  const { show, calls, requests } = setup("C:\\Workspace", undefined, { platform: "win32",
    realpath: async path => path.endsWith("escape") ? "C:\\workspace\\escape" : path,
    inspect: async () => ({ isDirectory: () => true, isFile: () => true }),
  });
  for (const path of ["src/changed.txt:stream", "CON.txt", "LPT¹", "src/.. /x", "folder.", "folder.{00000000-0000-0000-0000-000000000000}"]) {
    assert.deepEqual(await show({ ...sessionTarget, path }), failed, path);
  }
  assert.deepEqual(requests, []);
  assert.deepEqual(await show({ ...sessionTarget, path: "escape" }), failed);
  assert.deepEqual(calls, []);
  assert.deepEqual(await show(sessionTarget), { ok: true });
  assert.deepEqual(calls, [["select", "C:\\Workspace\\src\\main.ts"]]);
});

test("rejects macOS packages and sanitizes backend and shell failures", async t => {
  const { cwd, workspace } = await fixture(t);
  const denied = setup(cwd, workspace, { platform: "darwin", macFolder: async () => false });
  assert.deepEqual(await denied.show(workspaceTarget), failed);
  assert.deepEqual(denied.calls, []);
  const invalid = setup(cwd, workspace, { fetcher: async () => Response.json({ cwd }, { status: 401 }) });
  assert.deepEqual(await invalid.show(sessionTarget), failed);
  const app = setup(cwd, workspace);
  app.shell.openPath = async () => "private OS error";
  app.shell.showItemInFolder = () => { throw new Error("private OS error"); };
  assert.deepEqual(await app.show(workspaceTarget), failed);
  assert.deepEqual(await app.show(sessionTarget), failed);
});

test("does not open a directory replaced by an escaping link during macOS package detection", { skip: process.platform === "win32" }, async t => {
  const { cwd, workspace } = await fixture(t);
  const { show, calls } = setup(cwd, workspace, { macFolder: async path => {
    await rm(path, { recursive: true });
    await symlink(workspace, path, "dir");
    return true;
  } });
  assert.deepEqual(await show({ ...sessionTarget, path: "src", kind: "directory" }), failed);
  assert.deepEqual(calls, []);
});

test("actual macOS package detection distinguishes an ordinary directory from an app bundle", { skip: process.platform !== "darwin" }, async t => {
  const { cwd, workspace } = await fixture(t);
  await mkdir(join(cwd, "Unsafe.app", "Contents"), { recursive: true });
  const { show, calls } = setup(cwd, workspace, { macFolder: undefined });
  assert.deepEqual(await show({ ...sessionTarget, path: "Unsafe.app", kind: "directory" }), failed);
  assert.deepEqual(await show(workspaceTarget), { ok: true });
  assert.deepEqual(calls, [["open", workspace]]);
});

test("Open With exposes opaque choices and revalidates the app, session and path on launch", async t => {
  const { cwd, workspace } = await fixture(t);
  let available = true;
  const launches = [];
  const app = setup(cwd, workspace, { getApps: async () => ({
    list: async () => available ? [{ id: "/internal/System Editor.app", name: "System Editor", isDefault: true, icon: "https://example.com/unsafe.png" }] : [],
    open: async (...args) => { launches.push(args); },
  }) });
  const result = await app.list(sessionTarget);
  assert.equal(result.ok, true);
  assert.match(result.apps[0].id, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(result.apps[0], { id: result.apps[0].id, name: "System Editor", isDefault: true });
  assert.deepEqual(await app.open(sessionTarget, "/internal/System Editor.app"), failed);
  assert.deepEqual(await app.open({ ...sessionTarget, sessionId: "stale" }, result.apps[0].id), notFound);
  assert.deepEqual(await app.list(workspaceTarget), failed);
  assert.deepEqual(await app.open(sessionTarget, result.apps[0].id), { ok: true });
  available = false;
  assert.deepEqual(await app.open(sessionTarget, result.apps[0].id), failed);
  await writeFile(join(cwd, "script.cmd"), "");
  assert.deepEqual(await app.list({ ...sessionTarget, path: "script.cmd" }), { ok: true, apps: [] });
  assert.deepEqual(await app.open({ ...sessionTarget, path: "script.cmd" }, result.apps[0].id), failed);
  assert.deepEqual(launches, [[join(cwd, "src", "main.ts"), "/internal/System Editor.app", "file"]]);
});

test("preload exposes only the narrow native bridge on the macOS and Windows main frame", async () => {
  const script = readFileSync(new URL("../web-preview-preload.cjs", import.meta.url), "utf8");
  for (const [platform, isMainFrame] of [["darwin", true], ["win32", true], ["linux", true], ["darwin", false]]) {
    const exposed = {}, calls = [];
    runInNewContext(script, { process: { platform, isMainFrame }, require: () => ({
      contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api; } },
      ipcRenderer: { invoke: async (...args) => { calls.push(args); return { ok: true }; } },
    }) });
    const api = exposed.piDesktopFileManager;
    if (platform === "linux" || !isMainFrame) { assert.equal(api, undefined); continue; }
    assert.deepEqual(Object.keys(api), ["platform", "show", "listApps", "openWith"]);
    assert.equal(api.platform, platform);
    assert.deepEqual(await api.show(sessionTarget), { ok: true });
    await api.listApps(sessionTarget);
    await api.openWith(sessionTarget, "choice");
    assert.deepEqual(calls, [["file-manager:show", sessionTarget], ["file-manager:list-apps", sessionTarget], ["file-manager:open-with", sessionTarget, "choice"]]);
  }
  assert.equal(setup(undefined, undefined, { platform: "linux" }).handler, undefined);
});
