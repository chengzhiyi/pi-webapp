import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { verifyMacArchives } from "../../scripts/verify-desktop-archives.mjs";

const signing = { type: "ad-hoc", verified: true };

test("the actual DMG and ZIP are read-only verified, never launched or re-signed", async () => {
  const calls = []; const inspected = [];
  await verifyMacArchives({ dmg: "test installer.dmg", zip: "test update.zip", signing,
    run: async (file, args) => { calls.push({ file, args }); },
    inspectSignature: async path => { inspected.push(path); return signing; } });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].file, "/usr/bin/hdiutil");
  assert.deepEqual(calls[0].args.slice(0, 4), ["attach", "-readonly", "-nobrowse", "-mountpoint"]);
  assert.equal(calls[1].file, "/usr/bin/ditto");
  assert.deepEqual(calls[1].args.slice(0, 2), ["-x", "-k"]);
  assert.equal(calls[2].args[0], "detach");
  assert.equal(inspected.length, 2);
  assert.ok(inspected[0].endsWith(join("dmg", "pi.app")));
  assert.ok(inspected[1].endsWith(join("zip", "pi.app")));
  await assert.rejects(access(dirname(dirname(inspected[0]))), { code: "ENOENT" });
});

test("the main branch DMG-only release needs no ZIP or updater", async () => {
  const calls = [];
  await verifyMacArchives({ dmg: "test.dmg", signing,
    run: async (file, args) => { calls.push({ file, args }); }, inspectSignature: async () => signing });
  assert.deepEqual(calls.map(call => call.args[0]), ["attach", "detach"]);
});

test("invalid archive signatures and extraction failures fail packaging and still detach", async () => {
  for (const failure of ["dmg", "zip", "extract", "mismatch"]) {
    const calls = [];
    await assert.rejects(verifyMacArchives({ dmg: "test.dmg", zip: "test.zip", signing,
      run: async (file, args) => {
        calls.push({ file, args });
        if (failure === "extract" && file.endsWith("ditto")) throw new Error("extraction failed");
      },
      inspectSignature: async path => {
        if (path.endsWith(join(failure, "pi.app"))) throw new Error("invalid signature");
        return failure === "mismatch" ? { type: "developer-id", verified: true } : signing;
      } }));
    assert.equal(calls.at(-1).args[0], "detach");
  }
});
