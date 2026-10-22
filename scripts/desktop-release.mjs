import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { inspectMacAppSignature, validateSigningManifest } from "./desktop-signing.mjs";

export const releaseTargets = [
  { id: "mac-arm64", platform: "darwin", arch: "arm64", os: "mac", ext: "dmg", label: "macOS · Apple Silicon" },
  { id: "mac-x64", platform: "darwin", arch: "x64", os: "mac", ext: "dmg", label: "macOS · Intel" },
  { id: "win-x64", platform: "win32", arch: "x64", os: "win", ext: "exe", label: "Windows · x64" },
  { id: "linux-x64", platform: "linux", arch: "x64", artifactArch: "x86_64", os: "linux", ext: "AppImage", label: "Linux · x64" },
];
const smokeGates = ["native-name-menu-title-pi", "custom-app-icon-loads", "native-pty", "shared-browser-backend", "confirmed-stop-reaps-pi", "installer-payload-launch"];
export const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const json = (root, path) => readFile(join(root, path), "utf8").then(JSON.parse);
function targetFor(platform, arch) {
  const target = releaseTargets.find(value => value.platform === platform && value.arch === arch);
  assert.ok(target, "unsupported release platform/architecture");
  return target;
}
export function releaseIdentity(pkg, release, target = releaseTargets[0]) {
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(release.productName, "pi");
  assert.ok(Number.isSafeInteger(release.buildNumber) && release.buildNumber > 0);
  target = targetFor(target.platform, target.arch);
  return { version: pkg.version, build: release.buildNumber, tag: `desktop-v${pkg.version}-b${release.buildNumber}`,
    // electron-builder uses the Linux deployment spelling for AppImage's arch macro.
    filename: `pi-${pkg.version}-desktop.${release.buildNumber}-${target.os}-${target.artifactArch ?? target.arch}.${target.ext}` };
}
async function identity(root, target) { return releaseIdentity(await json(root, "package.json"), await json(root, "desktop/release.json"), target); }
export function validateSource(commit, repository, ref) {
  assert.match(commit, /^[a-f0-9]{40}$/);
  assert.match(repository, /^[\w.-]+\/[\w.-]+$/);
  assert.ok(!ref || typeof ref === "string");
}
export function validateRef(ref, spec) {
  if (ref?.startsWith("refs/tags/")) assert.equal(ref, `refs/tags/${spec.tag}`, "tag must match the version/build in this commit");
}
function gates(checks, target) {
  assert.ok(Array.isArray(checks));
  const required = [...smokeGates, "native-desktop-update-menu",
    ...(target?.id === "mac-arm64" ? ["native-desktop-update-download"] : [])];
  for (const check of required) assert.ok(checks.includes(check), `missing smoke gate: ${check}`);
}
const targetAssets = manifest => [manifest.asset, ...(manifest.updateAsset ? [manifest.updateAsset] : [])];
const checksumText = assets => assets.map(asset => `${asset.sha256}  ${asset.name}\n`).join("");
function macInstallNotes() {
  return `macOS 测试包默认使用完整 ad-hoc 临时签名（无需证书），没有发布者身份、未公证。` +
    `先核对官方来源与 SHA256SUMS，安装后运行 ` +
    '`codesign --verify --deep --strict --verbose=2 "/Applications/pi.app"`。' +
    `校验失败请停止，不要自行重签掩盖问题。校验通过且明确愿意信任此测试版后，` +
    `可尝试“系统设置 → 隐私与安全性 → 仍要打开”；若仍受下载隔离阻止，` +
    '可手动运行 `xattr -dr com.apple.quarantine "/Applications/pi.app"`，仅移除此应用的下载隔离。' +
    `此操作跳过该应用的隔离检查，不代表 Apple 安全认证；不要全局关闭系统安全保护。\n`;
}
function targetNotes(manifest) {
  const signing = manifest.platform === "darwin"
    ? (manifest.unsigned ? "Ad-hoc signed / no publisher identity / unnotarized" : "Publisher-signed / not notarized") : "Unsigned";
  return `${manifest.target}: ${manifest.filename}\nSource: ${manifest.sourceCommit}\n${signing} test build; Pi ${manifest.runtime.piVersion}.\n` +
    (manifest.platform === "darwin" ? macInstallNotes() : "");
}
async function filesExactly(directory, names) {
  assert.deepEqual((await readdir(directory)).sort(), [...names].sort(), "unexpected or missing release files");
  for (const name of names) assert.equal((await lstat(join(directory, name))).isFile(), true, "release files must not be symlinks");
}
async function checkAsset(directory, asset) {
  const bytes = await readFile(join(directory, asset.name));
  assert.equal(bytes.length, asset.bytes);
  assert.equal(hash(bytes), asset.sha256, "installer checksum mismatch");
  return bytes;
}

export async function prepareRelease({ root, output, sourceCommit, repository, ref, platform = process.platform, arch = process.arch,
  inspectSignature = inspectMacAppSignature }) {
  validateSource(sourceCommit, repository, ref);
  const target = targetFor(platform, arch);
  const spec = await identity(root, target); validateRef(ref, spec);
  const runtime = await json(root, ".desktop/runtime/build-info.json");
  assert.equal(runtime.version, spec.version); assert.equal(runtime.platform, platform); assert.equal(runtime.arch, arch);
  const smoke = await json(root, "artifacts/desktop/smoke-result.json");
  assert.equal(smoke.packaged, true); assert.equal(smoke.platform, platform); assert.equal(smoke.arch, arch);
  assert.equal(smoke.version, spec.version); assert.equal(smoke.desktopBuild, spec.build); assert.equal(smoke.appName, "pi");
  assert.equal(smoke.piVersion, runtime.piVersion);
  assert.equal(smoke.installerPayload, true); assert.deepEqual(smoke.errors, []); gates(smoke.checks, target);
  const source = join(root, "desktop-release", spec.filename);
  assert.equal((await lstat(source)).isFile(), true);
  const bytes = await readFile(source); assert.ok(bytes.length > 0);
  // Only macOS has codesign. Keep Windows/Linux's existing unsigned release path.
  const signing = platform === "darwin" ? await inspectSignature(join(root, "desktop-release", arch === "arm64" ? "mac-arm64" : "mac", "pi.app")) : undefined;
  const unsigned = signing ? signing.type === "ad-hoc" : true;
  if (platform === "darwin") validateSigningManifest(signing, unsigned);
  const manifest = { schemaVersion: 1, ...spec, productName: "pi", platform, arch, target: target.id, sourceCommit, repository,
    ...(signing ? { signing } : {}), unsigned, notarized: false, prerelease: true,
    runtime: { nodeVersion: runtime.nodeVersion, piVersion: runtime.piVersion, nodeArchiveSha256: runtime.nodeArchiveSha256 },
    smokeChecks: smoke.checks, asset: { name: spec.filename, bytes: bytes.length, sha256: hash(bytes) } };
  let updateBytes;
  if (target.id === "mac-arm64") {
    const name = spec.filename.replace(/\.dmg$/, ".zip");
    const path = join(root, "desktop-release", name);
    const info = await lstat(path).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (info) {
      assert.equal(info.isFile(), true, "update ZIP must not be a symlink");
      updateBytes = await readFile(path); assert.ok(updateBytes.length > 0);
      manifest.updateAsset = { name, bytes: updateBytes.length, sha256: hash(updateBytes) };
    }
  }
  await mkdir(output, { recursive: true }); assert.deepEqual(await readdir(output), [], "release output must start empty");
  await writeFile(join(output, spec.filename), bytes);
  if (updateBytes) await writeFile(join(output, manifest.updateAsset.name), updateBytes);
  await writeFile(join(output, "desktop-release.json"), JSON.stringify(manifest, null, 2) + "\n");
  await writeFile(join(output, "SHA256SUMS"), checksumText(targetAssets(manifest)));
  await writeFile(join(output, "release-notes.md"), targetNotes(manifest));
  return manifest;
}

async function checkTarget(root, manifest, target, sourceCommit, repository) {
  const spec = await identity(root, target);
  for (const [key, value] of Object.entries(spec)) assert.equal(manifest[key], value, `mismatched ${key}`);
  for (const [key, value] of Object.entries({ schemaVersion: 1, productName: "pi", target: target.id, platform: target.platform,
    arch: target.arch, sourceCommit, repository, notarized: false, prerelease: true })) assert.equal(manifest[key], value, `mismatched ${key}`);
  if (target.platform === "darwin") validateSigningManifest(manifest.signing, manifest.unsigned);
  else { assert.equal(manifest.unsigned, true); assert.equal(manifest.signing, undefined); }
  assert.equal(manifest.asset.name, spec.filename); gates(manifest.smokeChecks, target);
  if (manifest.updateAsset) {
    assert.equal(target.id, "mac-arm64", "native updater archives are only supported on macOS arm64");
    assert.equal(manifest.updateAsset.name, spec.filename.replace(/\.dmg$/, ".zip"));
  }
  assert.equal(manifest.runtime.piVersion, (await json(root, "package.json")).devDependencies["@earendil-works/pi-coding-agent"]);
  assert.match(manifest.runtime.nodeArchiveSha256, /^[a-f0-9]{64}$/);
}
export async function verifyRelease({ root, directory, sourceCommit, repository, platform = "darwin", arch = "arm64" }) {
  validateSource(sourceCommit, repository);
  const target = targetFor(platform, arch); const manifest = await json(directory, "desktop-release.json");
  await checkTarget(root, manifest, target, sourceCommit, repository);
  await filesExactly(directory, [...targetAssets(manifest).map(asset => asset.name), "desktop-release.json", "SHA256SUMS", "release-notes.md"]);
  for (const asset of targetAssets(manifest)) await checkAsset(directory, asset);
  assert.equal(await readFile(join(directory, "SHA256SUMS"), "utf8"), checksumText(targetAssets(manifest)));
  assert.equal(await readFile(join(directory, "release-notes.md"), "utf8"), targetNotes(manifest));
  return manifest;
}

export function releaseNotes(manifest) {
  return `# pi ${manifest.version} · desktop build ${manifest.build}\n\n` +
    `**Unsigned TEST prerelease · bundled Pi ${manifest.targets[0].runtime.piVersion}.**\n\n` +
    `| Platform / 平台 | Installer / 安装包 |\n| --- | --- |\n` + manifest.targets.map(value => {
      const label = releaseTargets.find(target => target.id === value.target).label;
      return `| ${label} | [${value.filename}](https://github.com/${manifest.repository}/releases/download/${manifest.tag}/${value.filename}) |\n`;
    }).join("") +
    `\nDownload the installer for your CPU. Compare **SHA256SUMS**; **desktop-release.json** records source SHA, runtime and per-platform smoke checks.\n\n` +
    `macOS: open the DMG and drag **pi.app** into Applications. Windows: run the EXE installer. Linux: \`chmod +x pi-*.AppImage\`, then run it; \`--appimage-extract-and-run\` is an alternative when FUSE is unavailable.\n\n` +
    `在“pi → 关于 pi”确认桌面构建 **${manifest.build}**。旧 Pi Webapp.app 不会因改名自动覆盖，请退出旧桌面并更新快捷方式。不要删除 ~/.pi。\n\n` +
    macInstallNotes() + `Windows/Linux 仍为未签名测试包。macOS ad-hoc 测试包仅支持下载校验后手动安装；发布者签名与更新归档齐备时，仍需另行确认系统安装。\n` +
    `[macOS 测试安装说明](https://github.com/${manifest.repository}/blob/${manifest.sourceCommit}/docs/desktop-testing.md)。\n\n` +
    `Node/Pi are bundled. Model credentials, Git/SSH and project toolchains are not. Existing compatible Web services may be reused; they are never automatically stopped or upgraded. A shared external service retains its own Pi version.\n\n` +
    `Windows ARM, Linux ARM and other architectures are not included. Native installer-payload launch, PTY, auth, shared browser and shutdown were smoke-tested on the four listed targets; real provider login/model billing and every desktop distribution were not tested.\n\n` +
    `Source: https://github.com/${manifest.repository}/commit/${manifest.sourceCommit}\n`;
}

export async function assembleRelease({ root, incoming, output, sourceCommit, repository }) {
  validateSource(sourceCommit, repository);
  const targets = [];
  for (const target of releaseTargets) targets.push(await verifyRelease({ root, directory: join(incoming, `verified-desktop-${target.id}`), sourceCommit, repository, ...target }));
  const { filename: _filename, ...spec } = await identity(root);
  const manifest = { schemaVersion: 2, ...spec, productName: "pi", sourceCommit, repository, unsigned: true, notarized: false, prerelease: true,
    targets, assets: targets.flatMap(targetAssets) };
  await mkdir(output, { recursive: true }); assert.deepEqual(await readdir(output), [], "bundle output must start empty");
  for (const target of targets) for (const asset of targetAssets(target)) {
    await writeFile(join(output, asset.name), await readFile(join(incoming, `verified-desktop-${target.target}`, asset.name)));
  }
  await writeFile(join(output, "desktop-release.json"), JSON.stringify(manifest, null, 2) + "\n");
  await writeFile(join(output, "SHA256SUMS"), checksumText(manifest.assets));
  await writeFile(join(output, "release-notes.md"), releaseNotes(manifest));
  return manifest;
}

export async function verifyBundle({ root, directory, sourceCommit, repository }) {
  validateSource(sourceCommit, repository); const manifest = await json(directory, "desktop-release.json");
  const { filename: _filename, ...spec } = await identity(root);
  for (const [key, value] of Object.entries({ schemaVersion: 2, ...spec, productName: "pi", sourceCommit, repository, unsigned: true, notarized: false, prerelease: true })) assert.equal(manifest[key], value, `mismatched ${key}`);
  assert.equal(manifest.targets.length, releaseTargets.length);
  for (const [index, target] of releaseTargets.entries()) await checkTarget(root, manifest.targets[index], target, sourceCommit, repository);
  assert.deepEqual(manifest.assets, manifest.targets.flatMap(targetAssets));
  for (const target of manifest.targets) assert.equal(target.runtime.nodeVersion, manifest.targets[0].runtime.nodeVersion);
  await filesExactly(directory, [...manifest.assets.map(value => value.name), "desktop-release.json", "SHA256SUMS", "release-notes.md"]);
  for (const asset of manifest.assets) await checkAsset(directory, asset);
  assert.equal(await readFile(join(directory, "SHA256SUMS"), "utf8"), checksumText(manifest.assets));
  assert.equal(await readFile(join(directory, "release-notes.md"), "utf8"), releaseNotes(manifest));
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = process.cwd(); const options = { root, output: join(root, ".desktop/release-assets"), sourceCommit: process.env.DESKTOP_SOURCE_COMMIT,
    repository: process.env.GITHUB_REPOSITORY, ref: process.env.GITHUB_REF };
  if (process.argv[2] === "--check-source") {
    validateSource(options.sourceCommit, options.repository, options.ref); validateRef(options.ref, await identity(root));
  } else if (process.argv[2] === "--assemble") {
    await assembleRelease({ ...options, incoming: join(root, ".desktop/incoming") });
  } else {
    assert.equal(process.argv.length, 2, "unknown desktop release argument");
    const manifest = await prepareRelease(options);
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `tag=${manifest.tag}\ncommit=${manifest.sourceCommit}\n`);
  }
}
