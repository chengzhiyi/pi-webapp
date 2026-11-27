import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";
import { createWindowsOpenWith } from "../open-with-windows.mjs";

const id = index => `win:${index.toString(16).padStart(64, "0")}`;
const example = "C:\\Work\\file.txt";

function setup(reply, options = {}) {
  const calls = [];
  const bridge = createWindowsOpenWith({
    platform: "win32", systemRoot: "D:\\Windows",
    exec(exe, args, opts, callback) {
      let json = "";
      const stdin = new Writable({ write(chunk, _, done) { json += chunk.toString("utf8"); done(); } });
      stdin.on("finish", () => {
        const input = JSON.parse(json);
        calls.push({ exe, args, opts, input });
        const result = reply(input);
        if (result instanceof Error) callback(result);
        else callback(null, typeof result === "string" ? result : JSON.stringify(result));
      });
      return { stdin };
    },
    ...options,
  });
  return { ...bridge, calls };
}

test("invokes the fixed system helper; Unicode and metacharacters are JSON data only", async () => {
  const { listWindowsApps, openWindowsApp, calls } = setup(input =>
    input.op === "list" ? [{ id: id(1), name: "Éditeur" }] : true);
  const path = "C:/Work/Résumé & ' $(Get-Date); %TEMP%! [test].txt";
  const normalized = path.replaceAll("/", "\\");
  assert.deepEqual(await listWindowsApps(path, "file"), [{ id: id(1), name: "Éditeur" }]);
  assert.equal(await openWindowsApp(path, id(1)), true);
  const [list, open] = calls;
  assert.equal(list.exe, "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.equal(list.opts.cwd, "D:\\Windows\\System32");
  assert.equal(list.opts.shell, false);
  assert.ok(list.opts.timeout > 0 && list.opts.maxBuffer > 0);
  assert.deepEqual(list.args, open.args);
  assert.deepEqual(list.args.slice(0, -1), ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand"]);
  const script = Buffer.from(list.args.at(-1), "base64").toString("utf16le");
  assert.ok(!script.includes("Get-Date") && !script.includes(id(1)));
  assert.deepEqual(list.input, { op: "list", path: normalized, kind: "file" });
  assert.deepEqual(open.input, { op: "open", path: normalized, appId: id(1) });
});

test("sanitizes, deduplicates and caps native results, preserving order", async () => {
  const apps = Array.from({ length: 18 }, (_, index) => ({ id: id(index), name: `Editor ${index}` }));
  const { listWindowsApps } = setup(() => [
    null, { id: "cmd.exe", name: "extra" }, { id: id(30), name: " " }, { id: id(31), name: "x".repeat(257) },
    { ...apps[0], executable: "D:\\editor.exe", icon: "https://example.com/icon" },
    { ...apps[0], name: "Duplicate" }, ...apps.slice(1),
  ]);
  assert.deepEqual(await listWindowsApps(example, "file"), apps.slice(0, 16));
});

test("source files can list registered editors and preserve only boolean default markers", async () => {
  const { listWindowsApps, openWindowsApp, calls } = setup(input => input.op === "list" ? [
    { id: id(1), name: "Editor", isDefault: true },
    { id: id(2), name: "Other editor", isDefault: "true" },
  ] : true);
  for (const ext of ["js", "py"]) {
    const path = `C:\\Work\\source.${ext}`;
    assert.deepEqual(await listWindowsApps(path, "file"), [
      { id: id(1), name: "Editor", isDefault: true }, { id: id(2), name: "Other editor" },
    ]);
    assert.equal(await openWindowsApp(path, id(1)), true);
  }
  const native = Buffer.from(calls[0].args.at(-1), "base64").toString("utf16le");
  assert.match(native, /UseShellExecute = false/);
  assert.doesNotMatch(native, /(?:handler|invoker)\.Invoke\(/);
});

test("directory discovery asks for the actual selection and has no synthetic fallback", async () => {
  const { listWindowsApps, calls } = setup(() => []);
  assert.deepEqual(await listWindowsApps("C:\\Work\\Folder.txt\\", "directory"), []);
  assert.deepEqual(calls[0].input, { op: "list", path: "C:\\Work\\Folder.txt", kind: "directory" });
});

test("an open request passes only an opaque id and honors the new native result", async () => {
  let current = id(1);
  const { listWindowsApps, openWindowsApp, calls } = setup(input =>
    input.op === "list" ? [{ id: current, name: "Editor" }] : input.appId === current);
  const [app] = await listWindowsApps(example, "file");
  current = id(2);
  assert.equal(await openWindowsApp(example, app.id), false);
  assert.equal(await openWindowsApp(example, current), true);
  assert.deepEqual(calls.map(call => call.input.op), ["list", "open", "open"]);
});

test("ambiguous or unsupported input never starts a helper", async () => {
  const { listWindowsApps, openWindowsApp, calls } = setup(() => assert.fail("unexpected helper call"));
  for (const path of [null, "file.txt", "C:relative.txt", "\\\\server\\share\\file.txt", "\\\\?\\C:\\file.txt",
    "C:\\Work\\..\\file.txt", "C:\\x.txt:stream", "C:\\x.txt\0", "C:\\Work \\file.txt", "C:\\CONIN$.txt",
    "C:\\folder.{00000000-0000-0000-0000-000000000000}\\file.txt"]) {
    assert.deepEqual(await listWindowsApps(path, "file"), []);
    assert.equal(await openWindowsApp(path, id(1)), false);
  }
  for (const appId of [null, "explorer", "C:\\Program Files\\Editor.exe", `${id(1)} -Command`, id(1).toUpperCase()]) {
    assert.equal(await openWindowsApp(example, appId), false);
  }
  assert.deepEqual(await listWindowsApps(example, "folder"), []);
  assert.equal(calls.length, 0);
  const offPlatform = setup(() => assert.fail("unexpected helper call"), { platform: "darwin" });
  assert.deepEqual(await offPlatform.listWindowsApps(example, "file"), []);
  assert.equal(await offPlatform.openWindowsApp(example, id(1)), false);
  assert.equal(offPlatform.calls.length, 0);
});

test("helper errors and malformed or unexpected output fail closed", async () => {
  for (const result of [new Error("timed out"), "not json", '"true"', { error: true }]) {
    const { listWindowsApps, openWindowsApp } = setup(() => result);
    assert.deepEqual(await listWindowsApps(example, "file"), []);
    assert.equal(await openWindowsApp(example, id(1)), false);
  }
});
