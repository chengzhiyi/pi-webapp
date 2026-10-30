import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const load = path => readFile(new URL(path, import.meta.url), "utf8").then(JSON.parse);
test("desktop runtime includes every host production dependency in its locked closure", async () => {
  const pkg = await load("../../package.json");
  const runtime = await load("../runtime-manifest/package.json");
  const lock = await load("../runtime-manifest/package-lock.json");
  const expected = { ...pkg.dependencies,
    "@earendil-works/pi-ai": pkg.devDependencies["@earendil-works/pi-ai"],
    "@earendil-works/pi-coding-agent": pkg.devDependencies["@earendil-works/pi-coding-agent"] };
  assert.deepEqual(runtime.dependencies, expected);
  assert.deepEqual(lock.packages[""].dependencies, expected);
  for (const name of Object.keys(expected)) assert.ok(lock.packages[`node_modules/${name}`], `${name} must be locked for the standalone runtime`);
});

test("host and bundled production runtime pin the same paired Pi SDK versions", async () => {
  const pkg = await load("../../package.json");
  const runtime = await load("../runtime-manifest/package.json");
  const lock = await load("../../package-lock.json");
  const runtimeLock = await load("../runtime-manifest/package-lock.json");
  const agent = pkg.devDependencies["@earendil-works/pi-coding-agent"];
  assert.match(agent, /^\d+\.\d+\.\d+$/, "pin a tested latest release, never a floating latest/range");
  for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai"]) {
    assert.equal(pkg.devDependencies[name], agent);
    assert.equal(runtime.dependencies[name], agent);
    assert.equal(lock.packages[`node_modules/${name}`].version, agent);
    assert.equal(runtimeLock.packages[`node_modules/${name}`].version, agent);
  }
});
