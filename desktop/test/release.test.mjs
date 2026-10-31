import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const config = require("../builder.cjs");
const release = require("../release.json");

test("native desktop identity is pi without renaming the npm backend or bundle ID", () => {
  assert.equal(release.productName, "pi");
  assert.equal(config.productName, "pi");
  assert.equal(config.executableName, "pi");
  assert.equal(config.appId, "dev.pi.webapp");
  assert.equal(require("../../package.json").name, "pi-webapp");
});

test("desktop rebuilds have a visible unique installer name and valid platform build version", () => {
  assert.ok(Number.isSafeInteger(release.buildNumber) && release.buildNumber >= 4);
  assert.equal(config.buildVersion, `${release.buildNumber}.0.0`);
  assert.match(config.buildVersion, /^\d+\.\d+\.\d+$/);
  assert.equal(config.artifactName, `pi-\${version}-desktop.${release.buildNumber}-\${os}-\${arch}.\${ext}`);
  assert.ok(config.files.includes("release.json"), "the About dialog must use the same identity as the installer");
  for (const file of ["updater.mjs", "update-release.mjs", "update-native.mjs", "quit.mjs", "stop-outcome.mjs"]) assert.ok(config.files.includes(file));
  assert.deepEqual(config.mac.target, ["dmg", "zip"]);
});

test("desktop rename preserves the pre-existing Electron profile while allowing isolated profiles", async () => {
  const main = await readFile(new URL("../main.mjs", import.meta.url), "utf8");
  assert.match(main, /hasSwitch\("user-data-dir"\)/);
  assert.match(main, /join\(app.getPath\("appData"\), "Pi Webapp"\)/);
  assert.match(main, /app.setPath\("userData", profile\)/);
  assert.match(main, /page-title-updated/);
});
