import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { SelfUpdater } from "../src/host/server/updates/self-update.ts";
import { desktopPeerSpecs, verifyDesktopPackage } from "../src/host/server/updates/desktop-package.ts";
import { dependencyRoot, desktopUpdatePath, readDesktopRelease } from "../desktop/managed-release.mjs";

async function installedPackage(prefix: string, version: string) {
  const root = join(prefix, "node_modules", "pi-webapp");
  for (const directory of ["bin", "dist", "web/dist"]) await mkdir(join(root, directory), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "pi-webapp", version, piWebappDesktopProtocol: 1 }));
  for (const file of ["bin/pi-webapp.mjs", "dist/extension.js", "web/dist/index.html"]) await writeFile(join(root, file), "");
  const pi = join(prefix, "node_modules", "@earendil-works", "pi-coding-agent");
  await mkdir(join(pi, "dist", "bundle"), { recursive: true });
  await writeFile(join(pi, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.3.0" }));
  await writeFile(join(pi, "dist", "bundle", "cli.js"), 'console.log("1.3.0")');
  return root;
}

test("capable desktop checks npm, stages outside the app, pins peers and persists a rollback selection", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-desktop-package 中文 "));
  try {
    const packageRoot = join(root, "pi.app", "backend");
    await mkdir(packageRoot, { recursive: true });
    const original = JSON.stringify({ name: "pi-webapp", version: "0.1.0" });
    await writeFile(join(packageRoot, "package.json"), original);
    const agentDir = join(root, "agent");
    const calls: string[][] = [];
    let latest = "0.2.0"; let verifications = 0; let incompatible = false;
    const options = { agentDir, packageRoot, launcherNonce: "desktop-owner", desktopManaged: true, desktopPackageUpdates: true,
      peerSpecs: async () => ["@earendil-works/pi-coding-agent@1.3.0", "@earendil-works/pi-ai@1.3.0"],
      verifyPackage: async () => { verifications++; },
      runNpm: async (args: string[]) => {
        calls.push(args);
        if (args[0] === "view") return JSON.stringify(latest);
        const installed = await installedPackage(args[args.indexOf("--prefix") + 1]!, latest);
        if (incompatible) await writeFile(join(installed, "package.json"), JSON.stringify({ name: "pi-webapp", version: latest, piWebappDesktopProtocol: 2 }));
        return "";
      } };
    const updater = new SelfUpdater(options);
    const status = await updater.check();
    assert.equal(status.available, true);
    assert.equal(status.canRestart, true);
    assert.ok(status.desktopShell);
    const first = await updater.prepare();
    const install = calls.find(args => args[0] === "install")!;
    for (const flag of ["--ignore-scripts", "--engine-strict", "@earendil-works/pi-coding-agent@1.3.0", "@earendil-works/pi-ai@1.3.0"]) assert.ok(install.includes(flag));
    assert.ok(first.launcher.startsWith(await realpath(agentDir)));
    assert.equal(verifications, 1);
    assert.equal((await readDesktopRelease(agentDir, "0.1.0"))?.launcher, first.launcher);
    assert.equal(await readFile(join(packageRoot, "package.json"), "utf8"), original);
    await assert.rejects(readFile(join(agentDir, "pi-web", "update.json")), { code: "ENOENT" });
    await updater.requestRestart(first);
    assert.equal(JSON.parse(await readFile(join(agentDir, "pi-web", "launcher.restart"), "utf8")).nonce, "desktop-owner");

    latest = "0.3.0";
    const next = new SelfUpdater({ ...options, packageRoot: dirname(dirname(first.launcher)) });
    await next.prepare();
    const selection = JSON.parse(await readFile(desktopUpdatePath(agentDir), "utf8"));
    assert.equal(selection.version, "0.3.0");
    assert.equal(selection.previous.launcher, first.launcher);

    const before = await readFile(desktopUpdatePath(agentDir), "utf8");
    latest = "0.4.0";
    const broken = new SelfUpdater({ ...options, verifyPackage: async () => { throw new Error("PTY probe failed"); } });
    await assert.rejects(broken.prepare(), /PTY probe failed/);
    assert.equal(await readFile(desktopUpdatePath(agentDir), "utf8"), before);
    incompatible = true;
    const checksBefore = verifications;
    await assert.rejects(new SelfUpdater(options).prepare(), /需要更新桌面外壳/);
    assert.equal(verifications, checksBefore, "incompatible packages must be rejected before running probes");
    assert.equal(await readFile(desktopUpdatePath(agentDir), "utf8"), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("desktop updates preserve the tested SDK pair and verify the reused native PTY with real Node", { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-native-package-"));
  try {
    const source = process.cwd();
    const expected = await Promise.all(["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai"].map(async name => `${name}@${JSON.parse(await readFile(join(await dependencyRoot(source, name), "package.json"), "utf8")).version}`));
    assert.deepEqual(await desktopPeerSpecs(source), expected);
    const installed = await installedPackage(root, "9.0.0");
    for (const spec of expected) {
      const split = spec.lastIndexOf("@"); const name = spec.slice(0, split); const version = spec.slice(split + 1);
      const dependency = join(root, "node_modules", name);
      await mkdir(dependency, { recursive: true });
      await writeFile(join(dependency, "package.json"), JSON.stringify({ name, version }));
      if (name.endsWith("pi-coding-agent")) await writeFile(join(dependency, "dist", "bundle", "cli.js"), `console.log(${JSON.stringify(version)})`);
    }
    // Intentionally unusable npm-native payload. The updater must replace only this
    // matching dependency with the tested runtime, never run dependency scripts.
    const pty = join(root, "node_modules", "node-pty");
    await mkdir(pty);
    await writeFile(join(pty, "package.json"), JSON.stringify({ name: "node-pty", version: "1.1.0" }));
    await mkdir(join(root, "node_modules", "@xterm"));
    await cp(join(source, "node_modules", "@xterm", "headless"), join(root, "node_modules", "@xterm", "headless"), { recursive: true });
    await mkdir(join(installed, "desktop"));
    await cp(join(source, "desktop", "check-pty.cjs"), join(installed, "desktop", "check-pty.cjs"));
    await verifyDesktopPackage(source, installed);
    assert.ok(await readFile(join(pty, "lib", "index.js")));
    await writeFile(join(pty, "package.json"), JSON.stringify({ name: "node-pty", version: "99.0.0" }));
    await assert.rejects(verifyDesktopPackage(source, installed), /需要更新桌面外壳/);
    assert.equal(JSON.parse(await readFile(join(pty, "package.json"), "utf8")).version, "99.0.0");
  } finally { await rm(root, { recursive: true, force: true }); }
});
