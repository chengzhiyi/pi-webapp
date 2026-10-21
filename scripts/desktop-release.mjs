import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { hasPublisherSignature } from "../desktop/update-native.mjs";

export function releaseIdentity(pkg, release) {
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/, "release needs a stable backend version");
  assert.equal(release.productName, "pi");
  assert.ok(Number.isSafeInteger(release.buildNumber) && release.buildNumber > 0);
  return { version: pkg.version, build: release.buildNumber,
    tag: `desktop-v${pkg.version}-b${release.buildNumber}`,
    filename: `pi-${pkg.version}-desktop.${release.buildNumber}-mac-arm64.dmg` };
}

export function validateSource(sourceCommit, repository, ref) {
  assert.match(sourceCommit, /^[a-f0-9]{40}$/);
  assert.match(repository, /^[\w.-]+\/[\w.-]+$/);
  assert.ok(!ref || typeof ref === "string");
}
export const hash = bytes => createHash("sha256").update(bytes).digest("hex");
export function validateRef(ref, spec) {
  if (ref?.startsWith("refs/tags/")) assert.equal(ref, `refs/tags/${spec.tag}`, "tag must match the version/build in this commit");
}
const requiredSmokeChecks = ["native-name-menu-title-pi", "custom-app-icon-loads", "native-desktop-update-menu", "native-desktop-update-download", "native-pty", "shared-browser-backend", "confirmed-stop-reaps-pi"];

export function releaseNotes(manifest) {
  return `# pi ${manifest.version} · desktop build ${manifest.build}\n\n` +
    `**${manifest.unsigned ? "Unsigned / unnotarized" : "Publisher-signed / not notarized"} TEST release — macOS Apple Silicon (arm64) only.**\n\n` +
    `Download **${manifest.asset.name}** below. SHA-256 is in **SHA256SUMS**; ` +
    `**desktop-release.json** records the exact source, runtime and smoke checks.\n\n` +
    `下载下方 DMG，拖入“应用程序”，打开 **pi.app**。在“pi → 关于 pi”确认桌面构建 **${manifest.build}**。` +
    `旧 Pi Webapp.app 是不同文件，不会因改名自动覆盖；请退出旧桌面并更新 Dock 快捷方式。不要删除 ~/.pi。\n\n` +
    (manifest.unsigned ? `本测试版未签名、未公证。桌面可下载校验 DMG，但不会自动安装未签名包。`
      : `本测试版具有发布者签名，但未声明公证。已签名桌面可通过 ZIP 进行同发布者系统校验及确认后安装。`) +
    `macOS 可能阻止打开；不要全局关闭系统安全保护。自动安装仍需已签名的当前应用。\n\n` +
    `Node/Pi are bundled; model credentials, Git/SSH and project toolchains are not. ` +
    `A compatible existing Web backend is reused without stopping it. Backend versions must match; ` +
    `an incompatible service is never automatically stopped or upgraded.\n\n` +
    `Windows, Linux and Intel macOS are **not validated or offered by this release**.\n\n` +
    `Source: https://github.com/${manifest.repository}/commit/${manifest.sourceCommit}\n` +
    `Backend ${manifest.version}; desktop ${manifest.build}; Node ${manifest.runtime.nodeVersion}; Pi ${manifest.runtime.piVersion}.\n`;
}

async function identity(root) {
  return releaseIdentity(JSON.parse(await readFile(join(root, "package.json"), "utf8")),
    JSON.parse(await readFile(join(root, "desktop/release.json"), "utf8")));
}

export async function prepareRelease({ root, output, sourceCommit, repository, ref, platform = process.platform, arch = process.arch }) {
  validateSource(sourceCommit, repository, ref);
  assert.equal(platform, "darwin", "only validated macOS arm64 may be released");
  assert.equal(arch, "arm64", "do not release an x64 binary as arm64");
  const spec = await identity(root);
  validateRef(ref, spec);
  const runtime = JSON.parse(await readFile(join(root, ".desktop/runtime/build-info.json"), "utf8"));
  assert.equal(runtime.version, spec.version);
  assert.equal(runtime.platform, platform);
  assert.equal(runtime.arch, arch);
  const smoke = JSON.parse(await readFile(join(root, "artifacts/desktop/smoke-result.json"), "utf8"));
  assert.equal(smoke.packaged, true);
  assert.equal(smoke.platform, platform);
  assert.equal(smoke.arch, arch);
  assert.equal(smoke.version, spec.version);
  assert.equal(smoke.desktopBuild, spec.build);
  assert.equal(smoke.appName, "pi");
  assert.deepEqual(smoke.errors, []);
  for (const check of requiredSmokeChecks) {
    assert.ok(smoke.checks.includes(check), `missing smoke gate: ${check}`);
  }
  const source = join(root, "desktop-release", spec.filename);
  assert.equal((await lstat(source)).isFile(), true);
  const bytes = await readFile(source);
  assert.ok(bytes.length > 0);
  const manifest = { schemaVersion: 1, ...spec, productName: "pi", platform: "darwin", arch: "arm64",
    sourceCommit, repository,
    unsigned: !await hasPublisherSignature(join(root, "desktop-release/mac-arm64/pi.app")),
    notarized: false, prerelease: true,
    runtime: { nodeVersion: runtime.nodeVersion, piVersion: runtime.piVersion, nodeArchiveSha256: runtime.nodeArchiveSha256 },
    smokeChecks: smoke.checks, asset: { name: spec.filename, bytes: bytes.length, sha256: hash(bytes) } };
  const zipName = spec.filename.replace(/\.dmg$/, ".zip");
  const zipPath = join(root, "desktop-release", zipName);
  assert.equal((await lstat(zipPath)).isFile(), true);
  const zip = await readFile(zipPath);
  assert.ok(zip.length > 0);
  manifest.updateAsset = { name: zipName, bytes: zip.length, sha256: hash(zip) };
  await mkdir(output, { recursive: true });
  assert.deepEqual(await readdir(output), [], "release output must start empty");
  await writeFile(join(output, spec.filename), bytes);
  await writeFile(join(output, zipName), zip);
  await writeFile(join(output, "desktop-release.json"), JSON.stringify(manifest, null, 2) + "\n");
  await writeFile(join(output, "SHA256SUMS"), `${manifest.asset.sha256}  ${spec.filename}\n${manifest.updateAsset.sha256}  ${zipName}\n`);
  await writeFile(join(output, "release-notes.md"), releaseNotes(manifest));
  return manifest;
}

export async function verifyRelease({ root, directory, sourceCommit, repository }) {
  const manifest = JSON.parse(await readFile(join(directory, "desktop-release.json"), "utf8"));
  validateSource(sourceCommit, repository);
  const spec = await identity(root);
  for (const [key, value] of Object.entries(spec)) assert.equal(manifest[key], value, `mismatched ${key}`);
  assert.equal(manifest.sourceCommit, sourceCommit);
  assert.equal(manifest.repository, repository);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.platform, "darwin");
  assert.equal(manifest.arch, "arm64");
  assert.equal(typeof manifest.unsigned, "boolean");
  assert.equal(manifest.notarized, false);
  assert.equal(manifest.prerelease, true);
  assert.equal(manifest.asset.name, spec.filename);
  assert.ok(Array.isArray(manifest.smokeChecks));
  for (const check of requiredSmokeChecks) assert.ok(manifest.smokeChecks.includes(check), `missing smoke gate: ${check}`);
  const zipName = spec.filename.replace(/\.dmg$/, ".zip");
  assert.equal(manifest.updateAsset?.name, zipName);
  const files = [spec.filename, zipName, "desktop-release.json", "SHA256SUMS", "release-notes.md"];
  assert.deepEqual((await readdir(directory)).sort(), files.sort(), "unexpected or missing release files");
  for (const file of files) assert.equal((await lstat(join(directory, file))).isFile(), true, "symlinks are not release files");
  const bytes = await readFile(join(directory, spec.filename));
  assert.equal(bytes.length, manifest.asset.bytes);
  assert.equal(hash(bytes), manifest.asset.sha256, "installer checksum mismatch");
  const zip = await readFile(join(directory, zipName));
  assert.ok(zip.length > 0);
  assert.equal(zip.length, manifest.updateAsset.bytes);
  assert.equal(hash(zip), manifest.updateAsset.sha256, "update ZIP checksum mismatch");
  assert.equal(await readFile(join(directory, "SHA256SUMS"), "utf8"), `${manifest.asset.sha256}  ${spec.filename}\n${manifest.updateAsset.sha256}  ${zipName}\n`);
  assert.equal(await readFile(join(directory, "release-notes.md"), "utf8"), releaseNotes(manifest));
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = process.cwd();
  const options = { root, output: join(root, ".desktop/release-assets"), sourceCommit: process.env.DESKTOP_SOURCE_COMMIT,
    repository: process.env.GITHUB_REPOSITORY, ref: process.env.GITHUB_REF };
  if (process.argv[2] === "--check-source") {
    validateSource(options.sourceCommit, options.repository, options.ref);
    validateRef(options.ref, await identity(root));
    console.log("Desktop release source/tag preflight passed.");
  } else {
    assert.equal(process.argv.length, 2, "unknown desktop release argument");
    const manifest = await prepareRelease(options);
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `tag=${manifest.tag}\ncommit=${manifest.sourceCommit}\n`);
    console.log(`Verified desktop release assets: ${manifest.tag}`);
  }
}
