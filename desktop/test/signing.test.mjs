import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { inspectMacAppSignature, validateSigningManifest } from "../../scripts/desktop-signing.mjs";

const adhoc = "Signature=adhoc\nTeamIdentifier=not set\nSealed Resources version=2 rules=13 files=42\n";
const publisher = "Authority=Developer ID Application: Example (ABCDEFGHIJ)\nTeamIdentifier=ABCDEFGHIJ\nSealed Resources version=2 rules=13 files=42\n";

test("test packaging explicitly selects ad-hoc, but never overrides an explicit publisher identity", () => {
  const load = name => JSON.parse(execFileSync(process.execPath, ["-e",
    'console.log(JSON.stringify(require("./desktop/builder.cjs").mac))'], {
    cwd: new URL("../../", import.meta.url), env: { ...process.env, CSC_NAME: name }, encoding: "utf8",
  }));
  assert.equal(load("").identity, "-");
  assert.equal(load("Developer ID Application: Example (ABCDEFGHIJ)").identity, "Developer ID Application: Example (ABCDEFGHIJ)");
  assert.equal(load("").strictVerify, true);
  assert.equal(load("").hardenedRuntime, true);
});

test("signature gate deep/strict-verifies the app before inspecting its resource seal and identity", async () => {
  const path = "/temporary/pi test.app";
  const calls = [];
  const run = async (file, args, options) => { calls.push({ file, args, options }); return { stderr: adhoc }; };
  assert.deepEqual(await inspectMacAppSignature(path, run), { type: "ad-hoc", verified: true });
  assert.equal(calls[0].file, "/usr/bin/codesign");
  assert.deepEqual(calls[0].args, ["--verify", "--deep", "--strict", path]);
  assert.deepEqual(calls[1].args, ["-dv", "--verbose=4", path]);
  assert.ok(calls.every(call => call.options.timeout > 0));
  assert.deepEqual(await inspectMacAppSignature(path, async () => ({ stderr: publisher })), { type: "developer-id", verified: true });
});

test("broken, unsealed and non-Developer-ID signatures fail closed rather than becoming unsigned releases", async () => {
  let calls = 0;
  await assert.rejects(inspectMacAppSignature("pi.app", async () => { calls++; throw new Error("invalid signature"); }), /invalid signature/);
  assert.equal(calls, 1);
  for (const stderr of [adhoc.replace(/Sealed Resources .*/, "Sealed Resources=none"), publisher.replace("Developer ID Application:", "Apple Development:"), publisher.replace("TeamIdentifier=ABCDEFGHIJ", "TeamIdentifier=not set")]) {
    await assert.rejects(inspectMacAppSignature("pi.app", async () => ({ stderr })));
  }
});

test("ad-hoc never becomes publisher authenticated in release metadata", () => {
  validateSigningManifest({ type: "ad-hoc", verified: true }, true);
  validateSigningManifest({ type: "developer-id", verified: true }, false);
  for (const [signing, unsigned] of [[undefined, true], [{ type: "ad-hoc", verified: false }, true], [{ type: "ad-hoc", verified: true }, false], [{ type: "developer-id", verified: true }, true], [{ type: "unknown", verified: true }, true]]) {
    assert.throws(() => validateSigningManifest(signing, unsigned));
  }
});

test("packaging gate is read-only and the wrapper retains no-publish/no-certificate-discovery behavior", async () => {
  const gate = await readFile(new URL("../../scripts/desktop-signing.mjs", import.meta.url), "utf8");
  assert.ok(!gate.includes("xattr"));
  assert.ok(!gate.includes('"--force"'));
  const wrapper = await readFile(new URL("../../scripts/package-desktop.mjs", import.meta.url), "utf8");
  assert.match(wrapper, /"--publish", "never"/);
  assert.match(wrapper, /CSC_IDENTITY_AUTO_DISCOVERY: "false"/);
  assert.match(wrapper, /await inspectMacAppSignature\(app\)/);
});
