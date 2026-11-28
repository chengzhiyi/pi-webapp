import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { hash, verifyBundle } from "./desktop-release.mjs";
import { signUpdateManifest, signatureName } from "./desktop-release-update-signature.mjs";

function runGh(args) { return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 4 * 1024 * 1024 }); }
function optionalJson(run, path) {
  try { return JSON.parse(run(["api", path])); }
  catch (error) {
    if (/HTTP 404/.test(String(error.stderr))) return null;
    throw error;
  }
}

export async function ensureTag({ run, repository, tag, commit }) {
  const base = `repos/${repository}/git`;
  let ref = optionalJson(run, `${base}/ref/tags/${encodeURIComponent(tag)}`);
  if (!ref) {
    run(["api", "--method", "POST", `${base}/refs`, "-f", `ref=refs/tags/${tag}`, "-f", `sha=${commit}`]);
    ref = optionalJson(run, `${base}/ref/tags/${encodeURIComponent(tag)}`);
  }
  let object = ref?.object;
  for (let depth = 0; object?.type === "tag" && depth < 8; depth++) object = JSON.parse(run(["api", `${base}/tags/${object.sha}`])).object;
  assert.equal(object?.type, "commit", "release tag does not resolve to a commit");
  assert.equal(object.sha, commit, "refusing to move or publish a tag for another source commit");
}

async function verifyRemoteFiles(run, repository, tag, directory, names) {
  const temporary = await mkdtemp(join(tmpdir(), "pi-release-download-"));
  try {
    run(["release", "download", tag, "--repo", repository, "--dir", temporary, ...names.flatMap(name => ["--pattern", name])]);
    for (const name of names) assert.equal(hash(await readFile(join(temporary, name))), hash(await readFile(join(directory, name))), `uploaded asset mismatch: ${name}`);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

export async function publishRelease({ root, directory, sourceCommit, repository, privateKeyPem, run = runGh }) {
  const manifest = await verifyBundle({ root, directory, sourceCommit, repository });
  const signed = await signUpdateManifest({ root, directory, privateKeyPem });
  await ensureTag({ run, repository, tag: manifest.tag, commit: sourceCommit });
  const releasePath = `repos/${repository}/releases/tags/${encodeURIComponent(manifest.tag)}`;
  let release = optionalJson(run, releasePath);
  const names = [...manifest.assets.map(asset => asset.name), "SHA256SUMS", "desktop-release.json", ...(signed ? [signatureName] : [])];
  const hasSignature = release?.assets.some(asset => asset.name === signatureName) ?? false;
  if (release && !release.draft) {
    assert.equal(release.prerelease, true, "refusing to alter a stable release");
    assert.equal(hasSignature, signed, "published release signature configuration differs; refusing to change assets");
    await verifyRemoteFiles(run, repository, manifest.tag, directory, names);
    return { url: release.html_url, tag: manifest.tag, sourceCommit, alreadyPublished: true };
  }
  assert.ok(signed || !hasSignature, "unsigned publication would leave a stale signature on the draft; remove it or restore signing");
  if (!release) {
    run(["release", "create", manifest.tag, "--repo", repository, "--verify-tag", "--draft", "--prerelease",
      "--title", `pi ${manifest.version} · desktop ${manifest.build} (macOS / Windows / Linux test)`, "--notes-file", join(directory, "release-notes.md")]);
  }
  // Draft uploads are replaceable on a retry; published releases are never clobbered.
  run(["release", "upload", manifest.tag, "--repo", repository, "--clobber", ...names.map(name => join(directory, name))]);
  await verifyRemoteFiles(run, repository, manifest.tag, directory, names);
  run(["release", "edit", manifest.tag, "--repo", repository, "--draft=false", "--prerelease=true", "--latest=false",
    "--notes-file", join(directory, "release-notes.md")]);
  release = optionalJson(run, releasePath);
  assert.equal(release?.draft, false);
  assert.equal(release.prerelease, true);
  for (const name of names) assert.ok(release.assets.some(asset => asset.name === name && asset.state === "uploaded"), `missing published asset ${name}`);
  return { url: release.html_url, tag: manifest.tag, sourceCommit, alreadyPublished: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const privateKeyPem = process.env.PI_WEBAPP_DESKTOP_UPDATE_PRIVATE_KEY;
  delete process.env.PI_WEBAPP_DESKTOP_UPDATE_PRIVATE_KEY; // Do not pass the secret on to gh.
  const receipt = await publishRelease({ root: process.cwd(), directory: resolve(".desktop/release-assets"),
    sourceCommit: process.env.DESKTOP_SOURCE_COMMIT, repository: process.env.GITHUB_REPOSITORY, privateKeyPem });
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `url=${receipt.url}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `## Desktop prerelease published\n\n${receipt.url}\n\nSource: ${receipt.sourceCommit}\n`);
  console.log(JSON.stringify(receipt));
}
