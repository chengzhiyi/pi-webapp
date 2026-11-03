import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL("./", import.meta.url));
const repository = "chengzhiyi/pi-webapp";
const requestedTag = process.argv[2];

async function github(path) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "pi-webapp-aur-updater",
      ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
    },
  });
  if (!response.ok) throw new Error(`GitHub API ${path}: HTTP ${response.status}`);
  return response.json();
}

function desktopIdentity(tag) {
  const match = /^desktop-v(\d+\.\d+\.\d+)-b([1-9]\d*)$/.exec(tag);
  if (!match) throw new Error(`Unsupported desktop release tag: ${tag}`);
  return { version: match[1], build: Number(match[2]) };
}

const release = requestedTag
  ? await github(`/repos/${repository}/releases/tags/${requestedTag}`)
  : (await github(`/repos/${repository}/releases?per_page=100`)).find(item => !item.draft && /^desktop-v\d+\.\d+\.\d+-b[1-9]\d*$/.test(item.tag_name));
if (!release) throw new Error("No published desktop release found");
if (release.draft) throw new Error(`${release.tag_name} is still a draft`);
const { version, build } = desktopIdentity(release.tag_name);
const filename = `pi-${version}-desktop.${build}-linux-x86_64.AppImage`;
for (const name of [filename, "SHA256SUMS"]) {
  if (!release.assets.some(asset => asset.name === name && asset.state === "uploaded")) throw new Error(`${release.tag_name} is missing ${name}`);
}
const checksumsUrl = release.assets.find(asset => asset.name === "SHA256SUMS").browser_download_url;
const checksumsResponse = await fetch(checksumsUrl);
if (!checksumsResponse.ok) throw new Error(`Could not download ${checksumsUrl}: HTTP ${checksumsResponse.status}`);
const checksums = await checksumsResponse.text();
const match = checksums.match(new RegExp(`^([a-f0-9]{64})  ${filename.replaceAll(".", "\\.")}$`, "m"));
if (!match) throw new Error(`${release.tag_name} has no trusted checksum for ${filename}`);

const pkgbuildPath = `${directory}PKGBUILD`;
const before = await readFile(pkgbuildPath, "utf8");
const next = before
  .replace(/^pkgver=.*$/m, `pkgver=${version}.b${build}`)
  .replace(/^_upstream_version=.*$/m, `_upstream_version=${version}`)
  .replace(/^_desktop_build=.*$/m, `_desktop_build=${build}`)
  .replace(/^pkgrel=.*$/m, "pkgrel=1")
  .replace(/^sha256sums=\('[^']*'\)$/m, `sha256sums=('${match[1]}')`);
if (next === before) {
  console.log(JSON.stringify({ tag: release.tag_name, changed: false }));
  process.exit(0);
}
await writeFile(pkgbuildPath, next);
const sourceUrl = `https://github.com/${repository}/releases/download/desktop-v${version}-b${build}/${filename}`;
const srcinfoPath = `${directory}.SRCINFO`;
const srcinfo = await readFile(srcinfoPath, "utf8");
const nextSrcinfo = srcinfo
  .replace(/^\tpkgver = .*$/m, `\tpkgver = ${version}.b${build}`)
  .replace(/^\tsource = .*$/m, `\tsource = ${sourceUrl}`)
  .replace(/^\tsha256sums = .*$/m, `\tsha256sums = ${match[1]}`);
await writeFile(srcinfoPath, nextSrcinfo);
console.log(JSON.stringify({ tag: release.tag_name, changed: true }));
