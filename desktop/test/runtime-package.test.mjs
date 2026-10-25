import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { applyRuntimePackageIdentity } from "../../scripts/desktop-runtime-package.mjs";

test("packaged backend preserves the actual host paired-runtime contract and pinned dependency tree", async () => {
  const source = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  const dependencies = { "node-pty": "1.1.0" };
  const manifest = applyRuntimePackageIdentity({ name: "runtime", private: true, dependencies }, source);
  assert.equal(manifest.name, "pi-webapp");
  assert.equal(manifest.version, source.version);
  assert.equal(manifest.type, "module");
  assert.equal(manifest.dependencies, dependencies);
  assert.equal(manifest.private, true);
  assert.equal(manifest.piWebappDesktopProtocol, source.piWebappDesktopProtocol);
  assert.equal(manifest.piWebappDataVersion, source.piWebappDataVersion);
  assert.deepEqual(manifest.piWebappHostedRuntime, source.piWebappHostedRuntime);
  assert.equal(manifest.piWebappHostedRuntime.pairJournal, 1);
  assert.notEqual(manifest.piWebappHostedRuntime, source.piWebappHostedRuntime);
});

test("packaging cannot inherit a paired contract that the source host never declared", () => {
  const manifest = applyRuntimePackageIdentity({ piWebappHostedRuntime: { pairJournal: 1 } }, { name: "pi-webapp", version: "0.1.0" });
  assert.equal(Object.hasOwn(manifest, "piWebappHostedRuntime"), false);
});
