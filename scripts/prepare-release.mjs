import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const published = execFileSync("npm", ["view", pkg.name, "version"], {
  encoding: "utf8",
}).trim();

function parts(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Expected a stable semver version, got ${version}`);
  }
  return version.split(".").map(Number);
}

const source = parts(pkg.version);
const latest = parts(published);
let sourceIsNewer = false;
for (let index = 0; index < 3; index++) {
  if (source[index] === latest[index]) continue;
  sourceIsNewer = source[index] > latest[index];
  break;
}
const next = sourceIsNewer
  ? pkg.version
  : `${latest[0]}.${latest[1]}.${latest[2] + 1}`;

execFileSync("npm", ["version", next, "--no-git-tag-version", "--allow-same-version"], {
  stdio: "inherit",
});
execFileSync("npm", ["pkg", "set", `pi.image=https://cdn.jsdelivr.net/npm/${pkg.name}@${next}/assets/cover-webapp.png`], {
  stdio: "inherit",
});
console.log(`Publishing ${pkg.name}@${next}`);
