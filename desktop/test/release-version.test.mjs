import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const builder = require("../builder.cjs");

test("the shared version helper is independently importable from the packaged desktop shell and npm allowlist", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-shell-version-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ["managed-release.mjs", "release-version.mjs"]) {
    assert.ok(builder.files.includes(name), `${name} must enter app.asar`);
    await cp(new URL(`../${name}`, import.meta.url), join(root, name));
  }
  const managed = await import(pathToFileURL(join(root, "managed-release.mjs")).href);
  assert.equal(managed.desktopProtocolVersion, 1);
  const version = await import(pathToFileURL(join(root, "release-version.mjs")).href);
  assert.ok(version.compareVersions("0.2.0-alpha.10", "0.2.0-alpha.2") > 0);
  const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  assert.ok(pkg.files.includes("desktop/release-version.mjs"));
  const prepare = await readFile(new URL("../../scripts/prepare-desktop.mjs", import.meta.url), "utf8");
  assert.match(prepare, /"desktop\/release-version.mjs"/);
  assert.match(prepare, /import \{ applyRuntimePackageIdentity \} from "\.\/desktop-runtime-package\.mjs"/);
  assert.match(prepare, /applyRuntimePackageIdentity\(manifest, pkg\)/); // Values are exercised by runtime-package.test.mjs.
});
