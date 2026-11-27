import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { listMacApps } from "../open-with-macos.mjs";

const skip = process.platform !== "darwin";
const exec = promisify(childProcess.execFile);
const finder = "/System/Library/CoreServices/Finder.app";

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-open-with-mac-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = join(root, "-folder '名' $(); quotes");
  const file = join(folder, '-document "名" $();\nline.txt');
  await mkdir(folder);
  await writeFile(file, "Open With test\n");
  return { root, folder, file };
}

async function nativeAssociations(path, kind) {
  const { stdout } = await exec("/usr/bin/osascript", ["-l", "JavaScript", "-e", `
    ObjC.import("AppKit");
    function run([path, kind]) {
      const target = $.NSURL.fileURLWithPathIsDirectory(path, kind === "directory");
      const workspace = $.NSWorkspace.sharedWorkspace;
      const primary = workspace.URLForApplicationToOpenURL(target);
      const handlers = workspace.URLsForApplicationsToOpenURL(target);
      const ids = [];
      for (let i = 0; i < handlers.count; i++) {
        ids.push(ObjC.unwrap(handlers.objectAtIndex(i).URLByResolvingSymlinksInPath.path));
      }
      return JSON.stringify({ primary: ObjC.unwrap(primary.URLByResolvingSymlinksInPath.path), ids });
    }`, "--", path, kind], { timeout: 5000 });
  return JSON.parse(stdout);
}

test("discovers real macOS file and folder associations with bounded optional PNGs", { skip }, async t => {
  const { file, folder } = await fixture(t);
  const pngSignature = Buffer.from("89504e470d0a1a0a", "hex");
  const iconPrefix = "data:image/png;base64,";
  for (const [path, kind] of [[file, "file"], [folder, "directory"]]) {
    const native = await nativeAssociations(path, kind);
    const entries = await listMacApps(path, kind);
    assert.ok(entries.length <= 16);
    assert.equal(new Set(entries.map(app => app.id)).size, entries.length);
    if (kind === "file" && native.primary && native.primary !== finder) {
      assert.equal(entries[0]?.id, native.primary);
      assert.equal(entries[0]?.isDefault, true);
    }
    for (const app of entries) {
      assert.ok(isAbsolute(app.id));
      assert.notEqual(app.id, finder);
      assert.ok(app.id === native.primary || native.ids.includes(app.id));
      assert.equal(app.isDefault, app.id === native.primary ? true : undefined);
      assert.ok(app.name.trim());
      if (app.icon !== undefined) {
        assert.ok(app.icon.startsWith(iconPrefix));
        const png = Buffer.from(app.icon.slice(iconPrefix.length), "base64");
        assert.deepEqual(png.subarray(0, 8), pngSignature);
        assert.ok(png.length <= 24 * 1024);
        for (const offset of [16, 20]) assert.ok(png.readUInt32BE(offset) > 0 && png.readUInt32BE(offset) <= 64);
      }
    }
  }
});

test("rejects invalid targets, symlinks, and directory packages", { skip }, async t => {
  const { root, file, folder } = await fixture(t);
  const link = join(root, "link.txt");
  await symlink(file, link);
  for (const [path, kind] of [
    [file, "directory"], [folder, "file"], [file, "other"], ["relative.txt", "file"],
    [join(root, "missing.txt"), "file"], [link, "file"], [finder, "directory"],
  ]) assert.deepEqual(await listMacApps(path, kind), []);
});

test("launch rechecks native membership and opens a document only via fixed positional arguments", { skip }, async t => {
  const { root, file, folder } = await fixture(t);
  const [app] = await listMacApps(file, "file");
  const [folderApp] = await listMacApps(folder, "directory");
  assert.ok(app, "expected a handler for a plain text document");
  const fakeApp = join(root, "Not Associated.app");
  await mkdir(fakeApp);
  const calls = [];
  let replaceTarget = false;
  const original = childProcess.execFile;
  childProcess.execFile = (command, args, options, done) => {
    calls.push({ command, args, options });
    if (command === "/usr/bin/open") return done(null, { stdout: "" });
    assert.equal(command, "/usr/bin/osascript");
    return original(command, args, options, async (error, stdout) => {
      try {
        if (replaceTarget) {
          await rename(file, `${file}.old`);
          await writeFile(file, "replacement");
        }
      } catch (error) {
        return done(error);
      }
      done(error, { stdout });
    });
  };
  syncBuiltinESMExports();
  let open;
  try {
    // A separate module instance captures the intercepted execFile, with no
    // production test hooks. Restore the builtin before running the assertions.
    ({ openMacApp: open } = await import("../open-with-macos.mjs?record-exec"));
  } finally {
    childProcess.execFile = original;
    syncBuiltinESMExports();
  }
  await assert.rejects(open(file, "--args"), /Invalid macOS Open With request/);
  assert.deepEqual(calls, []);
  await assert.rejects(open(file, fakeApp), /unavailable/);
  await assert.rejects(open(folder, finder), /unavailable/);
  assert.ok(calls.every(call => call.command === "/usr/bin/osascript"));
  calls.length = 0;

  assert.equal(await open(file, app.id), undefined);
  assert.deepEqual(calls.map(call => call.command), ["/usr/bin/osascript", "/usr/bin/open"]);
  const [query, launch] = calls;
  assert.deepEqual(query.args.slice(0, 3), ["-l", "JavaScript", "-e"]);
  assert.deepEqual(query.args.slice(4), ["--", file, "file", app.id]);
  assert.ok(!query.args[3].includes(file) && !query.args[3].includes(app.id));
  assert.deepEqual(launch.args, ["-a", app.id, "--", file]);
  assert.ok(!query.options.shell && !launch.options.shell);

  if (folderApp) {
    calls.length = 0;
    await open(folder, folderApp.id);
    assert.deepEqual(calls[0].args.slice(4), ["--", folder, "directory", folderApp.id]);
    assert.deepEqual(calls[1].args, ["-a", folderApp.id, "--", folder]);
  }

  calls.length = 0;
  replaceTarget = true;
  await assert.rejects(open(file, app.id), /changed before opening/);
  assert.deepEqual(calls.map(call => call.command), ["/usr/bin/osascript"]);
});
