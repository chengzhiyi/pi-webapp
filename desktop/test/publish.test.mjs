import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareRelease, verifyRelease, assembleRelease, verifyBundle, releaseTargets, releaseIdentity, validateRef } from "../../scripts/desktop-release.mjs";
import { ensureTag, publishRelease } from "../../scripts/publish-desktop-release.mjs";

const sourceCommit = "a".repeat(40), repository = "owner/project";
const checks = ["native-name-menu-title-pi", "custom-app-icon-loads", "native-pty", "shared-browser-backend", "confirmed-stop-reaps-pi", "installer-payload-launch"];
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-release-test-")); t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of ["desktop", ".desktop/runtime", "artifacts/desktop", "desktop-release"]) await mkdir(join(root, path), { recursive: true });
  const put = (path, value) => writeFile(join(root, path), JSON.stringify(value));
  const pkg = { version: "0.1.21", devDependencies: { "@earendil-works/pi-coding-agent": "1.3.0" } };
  const release = { productName: "pi", buildNumber: 6 };
  await put("package.json", pkg); await put("desktop/release.json", release);
  const options = { root, output: join(root, "assets"), sourceCommit, repository, platform: "darwin", arch: "arm64",
    inspectSignature: async () => ({ type: "ad-hoc", verified: true }) };
  const prepareTarget = async (target, output = options.output) => {
    const spec = releaseIdentity(pkg, release, target);
    await put(".desktop/runtime/build-info.json", { version: pkg.version, platform: target.platform, arch: target.arch,
      nodeVersion: "22.23.3", piVersion: "1.3.0", nodeArchiveSha256: "b".repeat(64) });
    await put("artifacts/desktop/smoke-result.json", { packaged: true, platform: target.platform, arch: target.arch,
      version: pkg.version, desktopBuild: release.buildNumber, appName: "pi", piVersion: "1.3.0", installerPayload: true, errors: [], checks });
    await writeFile(join(root, "desktop-release", spec.filename), "installer " + target.id);
    return { ...options, ...target, output };
  };
  await prepareTarget(releaseTargets[0]);
  const bundle = async () => {
    const incoming = join(root, "incoming");
    for (const target of releaseTargets) await prepareRelease(await prepareTarget(target, join(incoming, `verified-desktop-${target.id}`)));
    options.output = join(root, "bundle");
    return assembleRelease({ ...options, incoming });
  };
  return { root, put, options, bundle, prepareTarget, filename: releaseIdentity(pkg, release).filename };
}
const missing = () => Object.assign(new Error("not found"), { stderr: "HTTP 404" });
function githubMock(directory, manifest, { published = false, draft = false, corruptDownload = false } = {}) {
  const calls = [], names = [...manifest.assets.map(asset => asset.name), "SHA256SUMS", "desktop-release.json"];
  let release = published || draft ? { draft: !published, prerelease: true, html_url: "https://github.com/owner/project/releases/tag/" + manifest.tag, assets: [] } : null;
  const files = new Map();
  if (published) for (const name of names) files.set(name, readFileSync(join(directory, name)));
  const run = args => {
    calls.push(args);
    if (args[0] === "api") {
      if (args[1].includes("/git/ref/")) return JSON.stringify({ object: { type: "commit", sha: sourceCommit } });
      if (args[1].includes("/releases/tags/")) { if (!release) throw missing(); return JSON.stringify(release); }
    }
    if (args[0] === "release") {
      if (args[1] === "create") { release = { draft: true, prerelease: true, html_url: "https://github.com/owner/project/releases/tag/" + manifest.tag, assets: [] }; return ""; }
      if (args[1] === "upload") {
        assert.equal(release.draft, true);
        for (const name of names) files.set(name, readFileSync(join(directory, name)));
        release.assets = names.map(name => ({ name, state: "uploaded" })); return "";
      }
      if (args[1] === "download") {
        const destination = args[args.indexOf("--dir") + 1];
        for (const name of names) writeFileSync(join(destination, name), corruptDownload ? "altered upload" : files.get(name));
        return "";
      }
      if (args[1] === "edit") { assert.ok(args.includes("--draft=false")); assert.ok(args.includes("--latest=false")); release.draft = false; return ""; }
    }
    throw new Error("unexpected GitHub call");
  };
  return { run, calls, release: () => release };
}

test("release identity covers four explicit targets and rejects unsafe/mismatching tags", () => {
  // Real electron-builder output uses x86_64 only in the Linux asset filename;
  // runtime/runner architecture and target ID remain x64.
  const suffixes = { "mac-arm64": "mac-arm64.dmg", "mac-x64": "mac-x64.dmg", "win-x64": "win-x64.exe", "linux-x64": "linux-x86_64.AppImage" };
  assert.equal(releaseTargets.find(target => target.id === "linux-x64").arch, "x64");
  for (const target of releaseTargets) {
    const spec = releaseIdentity({ version: "0.1.21" }, { productName: "pi", buildNumber: 6 }, target);
    assert.equal(spec.tag, "desktop-v0.1.21-b6"); assert.equal(spec.filename, `pi-0.1.21-desktop.6-${suffixes[target.id]}`);
    validateRef("refs/tags/" + spec.tag, spec); assert.throws(() => validateRef("refs/tags/desktop-v0.1.20-b5", spec));
  }
  for (const version of ["latest", "0.1.21;echo secret", "0.1.21-beta"]) assert.throws(() => releaseIdentity({ version }, { productName: "pi", buildNumber: 6 }));
});

test("per-target receipts require actual native installer payload smoke and exact pinned Pi", async t => {
  const f = await fixture(t);
  await assert.rejects(prepareRelease({ ...f.options, platform: "win32", arch: "arm64" }));
  await assert.rejects(prepareRelease({ ...f.options, platform: "freebsd" }));
  const manifest = await prepareRelease(f.options);
  assert.deepEqual(manifest.signing, { type: "ad-hoc", verified: true });
  assert.equal(manifest.unsigned, true);
  const notes = await readFile(join(f.options.output, "release-notes.md"), "utf8");
  assert.match(notes, /Ad-hoc signed \/ no publisher identity \/ unnotarized/);
  assert.match(notes, /codesign --verify --deep --strict/);
  assert.match(notes, /校验失败请停止/);
  assert.match(notes, /xattr -dr com.apple.quarantine/);
  assert.deepEqual(await verifyRelease({ root: f.root, directory: f.options.output, sourceCommit, repository }), manifest);
  await assert.rejects(prepareRelease(f.options), /start empty/);
});

test("signature failures stop macOS receipts; explicit publisher signing remains distinct", async t => {
  const broken = await fixture(t);
  await assert.rejects(prepareRelease({ ...broken.options, inspectSignature: async () => { throw new Error("broken seal"); } }), /broken seal/);
  const signed = await fixture(t);
  const manifest = await prepareRelease({ ...signed.options, inspectSignature: async () => ({ type: "developer-id", verified: true }) });
  assert.equal(manifest.unsigned, false);
  assert.deepEqual(await verifyRelease({ root: signed.root, directory: signed.options.output, sourceCommit, repository }), manifest);
});

test("codesign gates both macOS architectures but never executes for Windows or Linux", async t => {
  for (const target of releaseTargets) {
    const f = await fixture(t); let inspected;
    const options = await f.prepareTarget(target);
    const manifest = await prepareRelease({ ...options, inspectSignature: async path => {
      assert.equal(target.platform, "darwin"); inspected = path; return { type: "ad-hoc", verified: true };
    } });
    if (target.platform === "darwin") assert.ok(inspected.endsWith(`${target.arch === "arm64" ? "mac-arm64" : "mac"}/pi.app`));
    else { assert.equal(inspected, undefined); assert.equal(manifest.signing, undefined); }
    await verifyRelease({ root: f.root, directory: options.output, sourceCommit, repository, ...target });
  }
});

test("failed, wrong-version, unpacked-only or incomplete smoke evidence cannot be released", async t => {
  for (const change of [{ packaged: false }, { desktopBuild: 5 }, { version: "0.1.20" }, { installerPayload: false }, { errors: ["failure"] }, { checks: [] }]) {
    const f = await fixture(t); const smoke = JSON.parse(await readFile(join(f.root, "artifacts/desktop/smoke-result.json"), "utf8"));
    await f.put("artifacts/desktop/smoke-result.json", { ...smoke, ...change }); await assert.rejects(prepareRelease(f.options));
  }
});

test("all four verified target artifacts assemble into one checksum-bound public bundle", async t => {
  const f = await fixture(t); const manifest = await f.bundle();
  assert.equal(manifest.assets.length, 4); assert.equal(manifest.schemaVersion, 2);
  assert.deepEqual(await verifyBundle({ root: f.root, directory: f.options.output, sourceCommit, repository }), manifest);
  assert.deepEqual(manifest.targets.map(value => value.target), releaseTargets.map(value => value.id));
});

test("missing platforms, altered bytes, extra files, wrong source and filename traversal block publication before GitHub", async t => {
  for (const change of ["installer", "extra", "source", "filename", "smoke", "missing-platform", "wrong-pi", "signature", "publisher"]) {
    const f = await fixture(t); const manifest = await f.bundle();
    if (change === "installer") await writeFile(join(f.options.output, f.filename), "altered");
    if (change === "extra") await writeFile(join(f.options.output, "unexpected.exe"), "extra");
    if (change === "source") manifest.sourceCommit = "c".repeat(40);
    if (change === "filename") manifest.assets[0].name = "../outside.dmg";
    if (change === "smoke") manifest.targets[0].smokeChecks = [];
    if (change === "missing-platform") manifest.targets.pop();
    if (change === "wrong-pi") manifest.targets[2].runtime.piVersion = "0.87.1";
    if (change === "signature") delete manifest.targets[0].signing;
    if (change === "publisher") manifest.targets[1].unsigned = false;
    if (!["installer", "extra"].includes(change)) await writeFile(join(f.options.output, "desktop-release.json"), JSON.stringify(manifest));
    let calls = 0;
    await assert.rejects(publishRelease({ root: f.root, directory: f.options.output, sourceCommit, repository, run: () => { calls++; throw new Error("must not reach GitHub"); } }));
    assert.equal(calls, 0);
  }
});

test("tag creation is allowed but existing/annotated tags may never move to another commit", async () => {
  let created = false;
  await ensureTag({ repository, tag: "desktop-v0.1.21-b6", commit: sourceCommit, run: args => {
    if (args.includes("POST")) { created = true; return "{}"; } if (!created) throw missing();
    return JSON.stringify({ object: { type: "commit", sha: sourceCommit } });
  } });
  await ensureTag({ repository, tag: "desktop-v0.1.21-b6", commit: sourceCommit, run: args => JSON.stringify({ object: args[1].includes("/ref/") ? { type: "tag", sha: "d".repeat(40) } : { type: "commit", sha: sourceCommit } }) });
  await assert.rejects(ensureTag({ repository, tag: "desktop-v0.1.21-b6", commit: sourceCommit, run: () => JSON.stringify({ object: { type: "commit", sha: "e".repeat(40) } }) }), /another source/);
});

test("a release stays draft until all six downloaded assets match; published retries never clobber", async t => {
  const f = await fixture(t); const manifest = await f.bundle(); const gh = githubMock(f.options.output, manifest);
  await publishRelease({ root: f.root, directory: f.options.output, sourceCommit, repository, run: gh.run });
  assert.equal(gh.release().draft, false); assert.equal(gh.release().assets.length, 6);
  assert.deepEqual(gh.calls.filter(args => args[0] === "release").map(args => args[1]), ["create", "upload", "download", "edit"]);
  const published = githubMock(f.options.output, manifest, { published: true });
  assert.equal((await publishRelease({ root: f.root, directory: f.options.output, sourceCommit, repository, run: published.run })).alreadyPublished, true);
  assert.ok(!published.calls.some(args => ["upload", "edit", "create"].includes(args[1])));
});

test("bad remote bytes leave a draft; an interrupted draft can be repaired", async t => {
  const f = await fixture(t); const manifest = await f.bundle(); const bad = githubMock(f.options.output, manifest, { corruptDownload: true });
  await assert.rejects(publishRelease({ root: f.root, directory: f.options.output, sourceCommit, repository, run: bad.run }), /uploaded asset mismatch/);
  assert.equal(bad.release().draft, true); assert.ok(!bad.calls.some(args => args[1] === "edit"));
  const retry = githubMock(f.options.output, manifest, { draft: true });
  await publishRelease({ root: f.root, directory: f.options.output, sourceCommit, repository, run: retry.run });
  assert.equal(retry.release().draft, false); assert.ok(!retry.calls.some(args => args[1] === "create"));
});

test("workflow builds four native targets, tests installer payloads, and gives write permissions only to the aggregator", async () => {
  const workflow = await readFile(new URL("../../.github/workflows/desktop-release.yml", import.meta.url), "utf8");
  for (const runner of ["macos-15", "macos-15-intel", "windows-2022", "ubuntu-22.04"]) assert.ok(workflow.includes(`runner: ${runner}`));
  for (const token of ["default: false", "include-hidden-files: true", "merge-multiple: false", "--assemble", "Start-Process", "--appimage-extract", "hdiutil attach", "xvfb-run"]) assert.ok(workflow.includes(token));
  const publish = workflow.slice(workflow.lastIndexOf("\n  publish:")); assert.ok(!publish.includes("npm ci"));
  assert.match(publish, /contents: write/); assert.match(publish, /publish-desktop-release.mjs/);
});
