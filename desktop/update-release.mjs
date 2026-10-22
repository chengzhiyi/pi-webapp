import { createHash } from "node:crypto";
import { open, rm } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

// This is a publisher boundary, not a URL supplied by a backend or renderer.
export const repository = "chengzhiyi/pi-webapp";
export const releasesUrl = `https://github.com/${repository}/releases`;
const api = `https://api.github.com/repos/${repository}/releases?per_page=100`;
const maxAssetBytes = 2 * 1024 ** 3;
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function compareDesktop(a, b) {
  const parts = value => {
    if (!versionPattern.test(value.version) || !Number.isSafeInteger(value.build) || value.build < 1) throw new Error("桌面版本信息无效");
    const result = [...value.version.split(".").map(Number), value.build];
    if (!result.every(Number.isSafeInteger)) throw new Error("桌面版本信息无效");
    return result;
  };
  const first = parts(a); const second = parts(b);
  for (let i = 0; i < first.length; i++) if (first[i] !== second[i]) return first[i] > second[i] ? 1 : -1;
  return 0;
}

function assetUrl(tag, name) { return `${releasesUrl}/download/${tag}/${name}`; }
function validDownload(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) throw new Error("更新下载地址无效");
  if (url.hostname === "github.com" && url.pathname.startsWith(`/${repository}/releases/download/`)) return url;
  if (url.hostname === "release-assets.githubusercontent.com") return url;
  throw new Error("拒绝非官方更新下载地址");
}

async function downloadResponse(url, fetchRequest, signal) {
  for (let redirects = 0; redirects < 5; redirects++) {
    validDownload(url);
    const response = await fetchRequest(url, { redirect: "manual", signal, headers: { "User-Agent": "pi-desktop-updater" } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new Error("更新下载重定向无效");
      url = new URL(location, url).href;
      continue;
    }
    if (response.status !== 200) { await response.body?.cancel(); throw new Error("更新下载失败，请稍后重试"); }
    return response;
  }
  throw new Error("更新下载重定向过多");
}

async function jsonResponse(response, limit = 2 * 1024 ** 2) {
  if (!response.body) throw new Error("更新信息为空");
  const reader = response.body.getReader(); const chunks = []; let bytes = 0;
  try {
    while (true) {
      const item = await reader.read(); if (item.done) break;
      bytes += item.value.length;
      if (bytes > limit) throw new Error("更新信息过大");
      chunks.push(Buffer.from(item.value));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

function validateAsset(asset, name) {
  if (asset?.name !== name || !Number.isSafeInteger(asset.bytes) || asset.bytes < 1 || asset.bytes > maxAssetBytes
      || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error("更新文件信息无效");
  return asset;
}

export function validateManifest(manifest, release, arch) {
  // Schema 2 aggregates native targets; select only a matching, source-bound
  // macOS receipt, then apply the same strict schema-1 installation checks.
  if (manifest.schemaVersion === 2) {
    const targets = manifest.targets?.filter(target => target.target === `mac-${arch}`);
    if (targets?.length !== 1 || !Array.isArray(manifest.assets)) throw new Error("更新发布缺少唯一的目标平台");
    const target = targets[0];
    for (const key of ["repository", "productName", "version", "build", "tag", "sourceCommit", "prerelease"]) {
      if (target[key] !== manifest[key]) throw new Error("更新平台与发布来源不一致");
    }
    for (const asset of [target.asset, target.updateAsset].filter(Boolean)) {
      const published = manifest.assets.filter(value => value.name === asset.name);
      if (published.length !== 1 || published[0].bytes !== asset.bytes || published[0].sha256 !== asset.sha256) {
        throw new Error("更新平台与发布文件不一致");
      }
    }
    manifest = target;
  }
  const tag = `desktop-v${manifest.version}-b${manifest.build}`;
  compareDesktop(manifest, manifest);
  if (manifest.schemaVersion !== 1 || manifest.repository !== repository || manifest.productName !== "pi"
      || manifest.platform !== "darwin" || manifest.arch !== arch || manifest.tag !== tag || release.tag_name !== tag
      || manifest.prerelease !== release.prerelease || typeof manifest.unsigned !== "boolean"
      || !/^[a-f0-9]{40}$/.test(manifest.sourceCommit)) throw new Error("更新发布信息与安装目标不一致");
  const prefix = `pi-${manifest.version}-desktop.${manifest.build}-mac-${arch}`;
  validateAsset(manifest.asset, `${prefix}.dmg`);
  if (manifest.updateAsset) validateAsset(manifest.updateAsset, `${prefix}.zip`);
  for (const asset of [manifest.asset, manifest.updateAsset].filter(Boolean)) {
    const remote = release.assets?.find(item => item.name === asset.name);
    if (!remote || remote.state !== "uploaded" || remote.size !== asset.bytes
        || remote.browser_download_url !== assetUrl(tag, asset.name)) throw new Error("更新发布缺少匹配的安装文件");
  }
  return Object.freeze({ ...manifest, asset: Object.freeze({ ...manifest.asset }),
    updateAsset: manifest.updateAsset ? Object.freeze({ ...manifest.updateAsset }) : undefined });
}

/** Explicit desktop test channel, including prereleases; npm's latest is unrelated. */
export async function checkDesktopRelease(current, { arch = process.arch, fetchRequest = fetch } = {}) {
  if (arch !== "arm64") throw new Error("当前桌面更新渠道仅支持 macOS Apple Silicon；其他平台请前往 Releases");
  const response = await fetchRequest(api, { redirect: "error", signal: AbortSignal.timeout(15000),
    headers: { Accept: "application/vnd.github+json", "User-Agent": "pi-desktop-updater" } });
  if (!response.ok) { await response.body?.cancel(); throw new Error("无法检查 GitHub 桌面更新（可能达到访问频率限制），请稍后重试"); }
  const releases = await jsonResponse(response);
  if (!Array.isArray(releases)) throw new Error("桌面更新列表无效");
  const candidates = [];
  for (const release of releases) {
    if (release.draft || typeof release.prerelease !== "boolean") continue;
    const match = /^desktop-v(\d+\.\d+\.\d+)-b([1-9]\d*)$/.exec(release.tag_name);
    if (!match) continue;
    const identity = { version: match[1], build: Number(match[2]) };
    if (compareDesktop(identity, current) > 0 && release.assets?.some(asset => asset.name === "desktop-release.json")) candidates.push({ release, identity });
  }
  candidates.sort((a, b) => compareDesktop(b.identity, a.identity));
  if (!candidates.length) return null;
  const { release } = candidates[0];
  const responseManifest = await downloadResponse(assetUrl(release.tag_name, "desktop-release.json"), fetchRequest, AbortSignal.timeout(15000));
  return validateManifest(await jsonResponse(responseManifest, 64 * 1024), release, arch);
}

/** Stream to a private, fresh file. Failed or cancelled downloads are never staged. */
export async function downloadDesktopAsset(manifest, asset, destination, { fetchRequest = fetch, signal = AbortSignal.timeout(15 * 60 * 1000), onProgress = () => {} } = {}) {
  if (asset !== manifest.asset && asset !== manifest.updateAsset) throw new Error("未知更新文件");
  validateAsset(asset, asset.name);
  const digest = createHash("sha256"); let bytes = 0; let file;
  try {
    const response = await downloadResponse(assetUrl(manifest.tag, asset.name), fetchRequest, signal);
    if (!response.body) throw new Error("更新文件为空");
    const length = response.headers.get("content-length");
    if (length !== null && Number(length) !== asset.bytes) { await response.body.cancel(); throw new Error("更新文件大小不匹配"); }
    const verify = new Transform({ transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > asset.bytes) { callback(new Error("更新文件大小超出发布声明")); return; }
      digest.update(chunk); onProgress(bytes / asset.bytes); callback(null, chunk);
    } });
    try { file = await open(destination, "wx", 0o600); }
    catch (error) { await response.body.cancel(); throw error; }
    await pipeline(Readable.fromWeb(response.body), verify, file.createWriteStream(), { signal });
    if (bytes !== asset.bytes || digest.digest("hex") !== asset.sha256) throw new Error("更新文件 SHA-256 校验失败，未安装");
    return destination;
  } catch (error) {
    if (file) { await file.close().catch(() => {}); await rm(destination, { force: true }); }
    throw error;
  }
}
