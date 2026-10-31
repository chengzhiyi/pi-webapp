import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { packagePiCli } from "../bin/package-pi-cli.mjs";

const peers = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai"];

test("published peers pin the SDK pair verified by the hosted adapter", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  for (const name of peers) {
    assert.equal(pkg.peerDependencies[name], "1.3.0");
    assert.equal(pkg.peerDependencies[name], pkg.devDependencies[name]);
  }
});

test("packaged launcher uses its verified local SDK, not a global or inherited Pi CLI", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-local-sdk 中文 ")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageRoot = join(root, "node_modules", "pi-webapp");
  await cp(new URL("../bin/", import.meta.url), join(packageRoot, "bin"), { recursive: true });
  await mkdir(join(packageRoot, "desktop"));
  for (const name of ["managed-release.mjs", "release-version.mjs", "stop-outcome.mjs", "launcher-handoff.mjs"]) await cp(new URL(`../desktop/${name}`, import.meta.url), join(packageRoot, "desktop", name));
  await mkdir(join(packageRoot, "dist")); await writeFile(join(packageRoot, "dist", "extension.js"), "");
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "pi-webapp", version: "0.1.31-alpha.6", peerDependencies: Object.fromEntries(peers.map(name => [name, "1.3.0"])) }));
  for (const name of ["cross-spawn", "undici"]) await symlink(resolve("node_modules", name), join(root, "node_modules", name), process.platform === "win32" ? "junction" : "dir");
  for (const name of peers) {
    const dependency = join(root, "node_modules", name);
    await mkdir(dependency, { recursive: true });
    await writeFile(join(dependency, "package.json"), JSON.stringify({ name, version: "1.3.0" }));
  }
  const piRoot = join(root, "node_modules", peers[0]!);
  const cli = join(piRoot, "dist", "bundle", "cli.js");
  await mkdir(join(piRoot, "dist", "bundle"), { recursive: true });
  await writeFile(cli, `const { createInterface } = require("node:readline");
createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  if (request.type === "get_commands") console.log(JSON.stringify({ type: "response", id: request.id, success: true, data: { commands: [{ name: "web", source: "extension", sourceInfo: { path: process.argv[process.argv.indexOf("-e") + 1] } }] } }));
  else console.log(JSON.stringify({ type: "extension_ui_request", method: "notify", message: "pi-webapp: http://127.0.0.1:12345/#fixture" }));
});
process.stdin.on("end", () => process.exit(0));`);
  assert.equal(await packagePiCli(packageRoot), cli);
  const agentDir = join(root, "agent");
  const env = { ...process.env, PATH: "", PI_WEBAPP_AUTO_OPEN: "0", PI_WEBAPP_RUNTIME: "npm", PI_CODING_AGENT_DIR: agentDir,
    PI_WEBAPP_PI_CLI: join(root, "obsolete-global-pi-1.4.0.js") };
  const run = (command: string) => spawnSync(process.execPath, [join(packageRoot, "bin", "pi-webapp.mjs"), command], { env, encoding: "utf8", timeout: 15000 });
  try {
    const started = run("start"); assert.equal(started.status, 0, started.stderr);
    const state = JSON.parse(await readFile(join(agentDir, "pi-web", "launcher.json"), "utf8"));
    assert.equal(state.version, "0.1.31-alpha.6");
    assert.ok(state.piPid > 0);
  } finally { const stopped = run("stop"); assert.equal(stopped.status, 0, stopped.stderr); }
  await writeFile(join(piRoot, "package.json"), JSON.stringify({ name: peers[0], version: "1.4.0" }));
  await assert.rejects(packagePiCli(packageRoot), /需要 1\.3\.0，实际为 1\.4\.0/);
  await mkdir(join(packageRoot, ".git"));
  assert.equal(await packagePiCli(packageRoot), null, "source checkouts keep their developer CLI workflow");
});
