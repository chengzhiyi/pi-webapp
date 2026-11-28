import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createNativeFileActions } from "../native-file-actions.mjs";

const file = { sessionId: "current", path: "src/report draft.txt", kind: "file" };
const folder = { workspaceId: "registered", path: "", kind: "directory" };
const failed = { ok: false, reason: "failed" };
const stats = root => path => ({ isDirectory: () => path === root, isFile: () => path !== root, dev: 1, ino: 2 });

test("Node macOS show uses the fixed Finder commands with literal path arguments", async () => {
  const root = "/workspace";
  const calls = [];
  const lookups = [];
  const act = createNativeFileActions({ platform: "darwin", realpath: path => path, inspect: stats(root), macFolder: () => true,
    runFile: async (...args) => { calls.push(args); },
  });
  const context = { lookupRoot: target => { lookups.push(target); return root; }, trusted: () => true };
  const name = "-draft;$(not-a-command).txt";
  assert.deepEqual(await act("show", { ...file, path: name }, undefined, context), { ok: true });
  assert.deepEqual(await act("show", folder, undefined, context), { ok: true });
  assert.deepEqual(lookups, [
    { sessionId: "current", segments: [name], kind: "file" },
    { workspaceId: "registered", segments: [], kind: "directory" },
  ]);
  assert.deepEqual(calls, [
    ["/usr/bin/open", ["-R", "--", `${root}/${name}`], { shell: false, timeout: 3000 }],
    ["/usr/bin/open", ["-a", "Finder", "--", root], { shell: false, timeout: 3000 }],
  ]);
});

test("Node Windows show dispatches only fixed Explorer commands and rejects ambiguous paths", async () => {
  const root = "C:\\My Workspace";
  const systemRoot = "C:\\Windows Install";
  const explorer = `${systemRoot}\\explorer.exe`;
  const calls = [];
  let spawnError = false;
  const act = createNativeFileActions({ platform: "win32", realpath: path => path, inspect: stats(root), systemRoot,
    spawnProcess: (...args) => {
      calls.push(args);
      const child = new EventEmitter();
      child.unref = () => {};
      queueMicrotask(() => spawnError ? child.emit("error", Object.assign(new Error(), { code: "ENOENT" })) : child.emit("spawn"));
      return child;
    },
  });
  const context = { lookupRoot: async () => root, trusted: () => true };
  assert.deepEqual(await act("show", file, undefined, context), { ok: true });
  assert.deepEqual(await act("show", folder, undefined, context), { ok: true });
  for (const path of ["src/a,b.txt", "src/a=b.txt", "src/%TEMP%.txt", "src/CONIN$.txt", 'src/a"b.txt']) {
    assert.deepEqual(await act("show", { ...file, path }, undefined, context), failed, path);
  }
  const options = { argv0: `"${explorer}"`, cwd: systemRoot, shell: false, windowsVerbatimArguments: true, stdio: "ignore" };
  assert.deepEqual(calls, [
    [explorer, [`/select,"${root}\\src\\report draft.txt"`], options],
    [explorer, [`/e,"${root}"`], options],
  ]);
  spawnError = true;
  assert.deepEqual(await act("show", file, undefined, context), failed);
});

test("shared Open With checks trust again after asynchronous discovery and root lookup", async () => {
  const root = "/workspace";
  let launches = 0;
  let trust = true;
  let revokeOnDiscovery = false;
  let revokeOnLookup = false;
  let lookups = 0;
  const act = createNativeFileActions({ platform: "darwin", realpath: path => path, inspect: stats(root),
    getApps: () => ({
      list: async () => {
        if (revokeOnDiscovery) trust = false;
        return [{ id: "known-editor", name: "Editor", isDefault: true }];
      },
      open: () => { launches++; },
    }),
    runFile: async () => assert.fail("Open With must not call the system show adapter"),
  });
  const context = {
    lookupRoot: async () => { if (++lookups === 2 && revokeOnLookup) trust = false; return root; },
    trusted: () => trust,
  };
  const { apps: [editor] } = await act("list", file, undefined, context);
  assert.deepEqual(await act("open", file, undefined, context), failed);
  revokeOnDiscovery = true;
  assert.deepEqual(await act("open", file, editor.id, context), failed);
  revokeOnDiscovery = false;
  revokeOnLookup = true;
  trust = true;
  lookups = 0;
  assert.deepEqual(await act("open", file, editor.id, context), failed);
  assert.equal(lookups, 2);
  assert.equal(launches, 0);
});

test("unknown operations and unsupported platforms do not perform root lookup", async () => {
  const context = { lookupRoot: () => assert.fail("unexpected lookup"), trusted: () => true };
  assert.deepEqual(await createNativeFileActions({ platform: "darwin" })("other", file, undefined, context), failed);
  assert.deepEqual(await createNativeFileActions({ platform: "linux" })("show", file, undefined, context), failed);
});
