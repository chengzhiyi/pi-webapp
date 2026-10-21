import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareRelease, verifyRelease, releaseIdentity, validateRef } from "../../scripts/desktop-release.mjs";
import { ensureTag, publishRelease } from "../../scripts/publish-desktop-release.mjs";

const sourceCommit = "a".repeat(40);
const repository = "owner/project";
const checks = ["native-name-menu-title-pi", "custom-app-icon-loads", "native-desktop-update-menu", "native-desktop-update-download", "native-pty", "shared-browser-backend", "confirmed-stop-reaps-pi"];
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-release-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of ["desktop", ".desktop/runtime", "artifacts/desktop", "desktop-release"]) await mkdir(join(root, path), { recursive: true });
  const put = (path, value) => writeFile(join(root, path), JSON.stringify(value));
  await put("package.json", { version: "0.1.20" });
  await put("desktop/release.json", { productName: "pi", buildNumber: 5 });
  await put(".desktop/runtime/build-info.json", { version: "0.1.20", platform: "darwin", arch: "arm64", nodeVersion: "22.23.3", piVersion: "0.87.1", nodeArchiveSha256: "b".repeat(64) });
  await put("artifacts/desktop/smoke-result.json", { packaged: true, platform: "darwin", arch: "arm64", version: "0.1.20", desktopBuild: 5, appName: "pi", errors: [], checks });
  const filename = "pi-0.1.20-desktop.5-mac-arm64.dmg";
  await writeFile(join(root, "desktop-release", filename), "installer fixture bytes");
  await writeFile(join(root, "desktop-release", filename.replace(/\.dmg$/, ".zip")), "update ZIP fixture bytes");
  const options = { root, output: join(root, "assets"), sourceCommit, repository, platform: "darwin", arch: "arm64",
    inspectSignature: async () => ({ type: "ad-hoc", verified: true }) };
  return { root, put, filename, options };
}
const missing = () => Object.assign(new Error("not found"), { stderr: "HTTP 404" });

function githubMock(directory, manifest, { published = false, draft = false, corruptDownload = false } = {}) {
  const calls = [];
  let release = published || draft ? { draft: !published, prerelease: true, html_url: "https://github.com/owner/project/releases/tag/" + manifest.tag, assets: [] } : null;
  const files = new Map();
  const names = [manifest.filename, manifest.updateAsset.name, "SHA256SUMS", "desktop-release.json"];
  if (published) for (const name of names) files.set(name, readFileSync(join(directory, name)));
  const run = args => {
    calls.push(args);
    if (args[0] === "api") {
      if (args[1].includes("/git/ref/")) return JSON.stringify({ object: { type: "commit", sha: sourceCommit } });
      if (args[1].includes("/releases/tags/")) { if (!release) throw missing(); return JSON.stringify(release); }
    }
    if (args[0] === "release") {
      const action = args[1];
      if (action === "create") { release = { draft: true, prerelease: true, html_url: "https://github.com/owner/project/releases/tag/" + manifest.tag, assets: [] }; return ""; }
      if (action === "upload") {
        assert.equal(release.draft, true, "never upload/clobber after publication");
        for (const name of names) files.set(name, readFileSync(join(directory, name)));
        release.assets = names.map(name => ({ name, state: "uploaded" })); return "";
      }
      if (action === "download") {
        const destination = args[args.indexOf("--dir") + 1];
        for (const name of names) writeFileSync(join(destination, name), corruptDownload ? "altered upload" : files.get(name));
        return "";
      }
      if (action === "edit") { assert.ok(args.includes("--draft=false")); assert.ok(args.includes("--latest=false")); release.draft = false; return ""; }
    }
    throw new Error("unexpected GitHub call: " + JSON.stringify(args));
  };
  return { run, calls, release: () => release };
}

test("desktop release identity rejects unsafe/mismatching tag and version inputs", () => {
  const spec = releaseIdentity({ version: "0.1.20" }, { productName: "pi", buildNumber: 5 });
  assert.equal(spec.tag, "desktop-v0.1.20-b5");
  validateRef("refs/tags/" + spec.tag, spec);
  assert.throws(() => validateRef("refs/tags/desktop-v0.1.19-b4", spec));
  for (const version of ["latest", "0.1.20;echo secret", "0.1.20-beta"]) assert.throws(() => releaseIdentity({ version }, { productName: "pi", buildNumber: 5 }));
  assert.throws(() => releaseIdentity({ version: "0.1.20" }, { productName: "pi", buildNumber: -1 }));
});

test("only a packaged native arm64 smoke produces checksummed source-bound release assets", async t => {
  const f = await fixture(t);
  await assert.rejects(prepareRelease({ ...f.options, arch: "x64" }));
  await assert.rejects(prepareRelease({ ...f.options, platform: "linux" }));
  await assert.rejects(prepareRelease({ ...f.options, ref: "refs/tags/desktop-v0.1.19-b4" }));
  const manifest = await prepareRelease(f.options);
  assert.equal(manifest.prerelease, true);
  assert.equal(manifest.unsigned, true);
  assert.deepEqual(manifest.signing, { type: "ad-hoc", verified: true });
  const notes = await readFile(join(f.options.output, "release-notes.md"), "utf8");
  assert.match(notes, /Ad-hoc signed \/ no publisher identity \/ unnotarized/);
  assert.match(notes, /codesign --verify --deep --strict/);
  assert.match(notes, /校验失败请停止/);
  assert.match(notes, /xattr -dr com.apple.quarantine/);
  assert.deepEqual(await verifyRelease({ root: f.root, directory: f.options.output, sourceCommit, repository }), manifest);
  await assert.rejects(prepareRelease(f.options), /start empty/);
});

test("signature failures prevent release preparation; verified Developer ID is labeled separately", async t => {
  const broken = await fixture(t);
  await assert.rejects(prepareRelease({ ...broken.options, inspectSignature: async () => { throw new Error("broken resource seal"); } }), /broken resource seal/);
  const signed = await fixture(t);
  const manifest = await prepareRelease({ ...signed.options, inspectSignature: async () => ({ type: "developer-id", verified: true }) });
  assert.equal(manifest.unsigned, false);
  assert.equal(manifest.signing.type, "developer-id");
  assert.deepEqual(await verifyRelease({ root: signed.root, directory: signed.options.output, sourceCommit, repository }), manifest);
});

test("failed, wrong-version or incomplete smoke evidence cannot be released", async t => {
  for (const change of [{ packaged: false }, { desktopBuild: 4 }, { version: "0.1.19" }, { errors: ["failure"] }, { checks: [] }]) {
    const f = await fixture(t);
    const smoke = JSON.parse(await readFile(join(f.root, "artifacts/desktop/smoke-result.json"), "utf8"));
    await f.put("artifacts/desktop/smoke-result.json", { ...smoke, ...change });
    await assert.rejects(prepareRelease(f.options));
  }
});

test("altered installer, extra files, wrong source, filename traversal and absent smoke gate block upload", async t => {
  for (const change of ["installer", "zip", "extra", "source", "filename", "smoke", "signature", "publisher"]) {
    const f = await fixture(t);
    const manifest = await prepareRelease(f.options);
    if (change === "installer") await writeFile(join(f.options.output, f.filename), "altered");
    if (change === "zip") await writeFile(join(f.options.output, manifest.updateAsset.name), "altered ZIP");
    if (change === "extra") await writeFile(join(f.options.output, "unexpected.exe"), "extra");
    if (change === "source") manifest.sourceCommit = "c".repeat(40);
    if (change === "filename") manifest.asset.name = "../outside.dmg";
    if (change === "smoke") manifest.smokeChecks = [];
    if (change === "signature") delete manifest.signing;
    if (change === "publisher") manifest.unsigned = false;
    if (["source", "filename", "smoke", "signature", "publisher"].includes(change)) await writeFile(join(f.options.output, "desktop-release.json"), JSON.stringify(manifest));
    let calls = 0;
    await assert.rejects(publishRelease({ root: f.root, directory: f.options.output, sourceCommit, repository, run: () => { calls++; throw new Error("must not reach GitHub"); } }));
    assert.equal(calls, 0, "local validation must fail before any GitHub operation");
  }
});

test("release tags may be created, but existing/annotated tags may never be moved to another commit", async () => {
  let created = false;
  await ensureTag({ repository, tag: "desktop-v0.1.20-b5", commit: sourceCommit, run: args => {
    if (args.includes("POST")) { created = true; return "{}"; }
    if (!created) throw missing();
    return JSON.stringify({ object: { type: "commit", sha: sourceCommit } });
  } });
  assert.equal(created, true);
  await ensureTag({ repository, tag: "desktop-v0.1.20-b5", commit: sourceCommit, run: args => JSON.stringify({ object: args[1].includes("/ref/") ? { type: "tag", sha: "d".repeat(40) } : { type: "commit", sha: sourceCommit } }) });
  await assert.rejects(ensureTag({ repository, tag: "desktop-v0.1.20-b5", commit: sourceCommit, run: () => JSON.stringify({ object: { type: "commit", sha: "e".repeat(40) } }) }), /another source/);
});

test("a release stays draft until its downloaded assets match, then becomes an explicitly non-latest prerelease", async t => {
  const f = await fixture(t); const manifest = await prepareRelease(f.options);
  const gh = githubMock(f.options.output, manifest);
  const receipt = await publishRelease({ root: f.root, directory: f.options.output, sourceCommit, repository, run: gh.run });
  assert.equal(receipt.alreadyPublished, false);
  assert.equal(gh.release().draft, false);
  const actions = gh.calls.filter(args => args[0] === "release").map(args => args[1]);
  assert.deepEqual(actions, ["create", "upload", "download", "edit"]);
});

test("bad uploaded bytes leave a draft; a verified published retry is a no-op", async t => {
  const f = await fixture(t); const manifest = await prepareRelease(f.options);
  const bad = githubMock(f.options.output, manifest, { corruptDownload: true });
  await assert.rejects(publishRelease({ root: f.root, directory: f.options.output, sourceCommit, repository, run: bad.run }), /uploaded asset mismatch/);
  assert.equal(bad.release().draft, true);
  assert.ok(!bad.calls.some(args => args[1] === "edit"));
  const published = githubMock(f.options.output, manifest, { published: true });
  const receipt = await publishRelease({ root: f.root, directory: f.options.output, sourceCommit, repository, run: published.run });
  assert.equal(receipt.alreadyPublished, true);
  assert.ok(!published.calls.some(args => ["upload", "edit", "create"].includes(args[1])));
});

test("an interrupted draft upload can be repaired without recreating or moving the tag", async t => {
  const f = await fixture(t); const manifest = await prepareRelease(f.options);
  const gh = githubMock(f.options.output, manifest, { draft: true });
  await publishRelease({ root: f.root, directory: f.options.output, sourceCommit, repository, run: gh.run });
  assert.equal(gh.release().draft, false);
  assert.ok(!gh.calls.some(args => args[1] === "create"));
  assert.deepEqual(gh.calls.filter(args => args[0] === "release").map(args => args[1]), ["upload", "download", "edit"]);
});

test("desktop release workflow gates publication separately from dependency installation/build", async () => {
  const workflow = await readFile(new URL("../../.github/workflows/desktop-release.yml", import.meta.url), "utf8");
  assert.match(workflow, /tags: \["desktop-v\*"\]/);
  assert.match(workflow, /default: false/);
  assert.match(workflow, /include-hidden-files: true/);
  assert.match(workflow, /runs-on: macos-15/);
  assert.match(workflow, /desktop:smoke -- --packaged/);
  assert.match(workflow, /ref: \$\{\{ github.sha \}\}/);
  assert.match(workflow, /permissions:\n      contents: write/);
  const publish = workflow.slice(workflow.lastIndexOf("\n  publish:"));
  assert.ok(!publish.includes("npm ci"));
  assert.match(publish, /publish-desktop-release.mjs/);
});
