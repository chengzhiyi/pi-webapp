import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const releaseTargets = [
  { id: "mac-arm64", platform: "darwin", arch: "arm64", os: "mac", ext: "dmg", label: "macOS · Apple Silicon" },
  { id: "mac-x64", platform: "darwin", arch: "x64", os: "mac", ext: "dmg", label: "macOS · Intel" },
  { id: "win-x64", platform: "win32", arch: "x64", os: "win", ext: "exe", label: "Windows · x64" },
  { id: "linux-x64", platform: "linux", arch: "x64", os: "linux", ext: "AppImage", label: "Linux · x64" },
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
    filename: `pi-${pkg.version}-desktop.${release.buildNumber}-${target.os}-${target.arch}.${target.ext}` };
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
function gates(checks) {
  assert.ok(Array.isArray(checks));
  for (const check of smokeGates) assert.ok(checks.includes(check), `missing smoke gate: ${check}`);
}
const checksumText = assets => assets.map(asset => `${asset.sha256}  ${asset.name}\n`).join("");
function targetNotes(manifest) { return `${manifest.target}: ${manifest.filename}\nSource: ${manifest.sourceCommit}\nUnsigned test build; Pi ${manifest.runtime.piVersion}.\n`; }
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

export async function prepareRelease({ root, output, sourceCommit, repository, ref, platform = process.platform, arch = process.arch }) {
  validateSource(sourceCommit, repository, ref);
  const target = targetFor(platform, arch);
  const spec = await identity(root, target); validateRef(ref, spec);
  const runtime = await json(root, ".desktop/runtime/build-info.json");
  assert.equal(runtime.version, spec.version); assert.equal(runtime.platform, platform); assert.equal(runtime.arch, arch);
  const smoke = await json(root, "artifacts/desktop/smoke-result.json");
  assert.equal(smoke.packaged, true); assert.equal(smoke.platform, platform); assert.equal(smoke.arch, arch);
  assert.equal(smoke.version, spec.version); assert.equal(smoke.desktopBuild, spec.build); assert.equal(smoke.appName, "pi");
  assert.equal(smoke.piVersion, runtime.piVersion);
  assert.equal(smoke.installerPayload, true); assert.deepEqual(smoke.errors, []); gates(smoke.checks);
  const source = join(root, "desktop-release", spec.filename);
  assert.equal((await lstat(source)).isFile(), true);
  const bytes = await readFile(source); assert.ok(bytes.length > 0);
  const manifest = { schemaVersion: 1, ...spec, productName: "pi", platform, arch, target: target.id, sourceCommit, repository,
    unsigned: true, notarized: false, prerelease: true,
    runtime: { nodeVersion: runtime.nodeVersion, piVersion: runtime.piVersion, nodeArchiveSha256: runtime.nodeArchiveSha256 },
    smokeChecks: smoke.checks, asset: { name: spec.filename, bytes: bytes.length, sha256: hash(bytes) } };
  await mkdir(output, { recursive: true }); assert.deepEqual(await readdir(output), [], "release output must start empty");
  await writeFile(join(output, spec.filename), bytes);
  await writeFile(join(output, "desktop-release.json"), JSON.stringify(manifest, null, 2) + "\n");
  await writeFile(join(output, "SHA256SUMS"), checksumText([manifest.asset]));
  await writeFile(join(output, "release-notes.md"), targetNotes(manifest));
  return manifest;
}

async function checkTarget(root, manifest, target, sourceCommit, repository) {
  const spec = await identity(root, target);
  for (const [key, value] of Object.entries(spec)) assert.equal(manifest[key], value, `mismatched ${key}`);
  for (const [key, value] of Object.entries({ schemaVersion: 1, productName: "pi", target: target.id, platform: target.platform,
    arch: target.arch, sourceCommit, repository, unsigned: true, notarized: false, prerelease: true })) assert.equal(manifest[key], value, `mismatched ${key}`);
  assert.equal(manifest.asset.name, spec.filename); gates(manifest.smokeChecks);
  assert.equal(manifest.runtime.piVersion, (await json(root, "package.json")).devDependencies["@earendil-works/pi-coding-agent"]);
  assert.match(manifest.runtime.nodeArchiveSha256, /^[a-f0-9]{64}$/);
}
export async function verifyRelease({ root, directory, sourceCommit, repository, platform = "darwin", arch = "arm64" }) {
  validateSource(sourceCommit, repository);
  const target = targetFor(platform, arch); const manifest = await json(directory, "desktop-release.json");
  await checkTarget(root, manifest, target, sourceCommit, repository);
  await filesExactly(directory, [manifest.filename, "desktop-release.json", "SHA256SUMS", "release-notes.md"]);
  await checkAsset(directory, manifest.asset);
  assert.equal(await readFile(join(directory, "SHA256SUMS"), "utf8"), checksumText([manifest.asset]));
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
    `本测试版未签名、macOS未公证；系统可能阻止打开。仅在确认来源可信后按系统的单应用安全提示处理，不要全局关闭安全保护。正式签名发行及桌面自动更新尚未提供。\n\n` +
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
    targets, assets: targets.map(value => value.asset) };
  await mkdir(output, { recursive: true }); assert.deepEqual(await readdir(output), [], "bundle output must start empty");
  for (const target of targets) await writeFile(join(output, target.filename), await readFile(join(incoming, `verified-desktop-${target.target}`, target.filename)));
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
  assert.deepEqual(manifest.assets, manifest.targets.map(value => value.asset));
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
