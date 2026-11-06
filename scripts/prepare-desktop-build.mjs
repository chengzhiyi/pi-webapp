import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { npmCommand } from "../bin/npm-command.mjs";
import { changelogPaths, promoteUnreleased } from "./changelog.mjs";
import { fetchDistTags } from "./npm-dist-tags.mjs";
import { planDesktopVersion } from "./release-plan.mjs";

// npm publishes never write versions back, so each desktop build commit records the
// backend version it bundles. Run before committing "prepare desktop build N".
const root = fileURLToPath(new URL("../", import.meta.url));
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const releasePath = join(root, "desktop", "release.json");
const release = JSON.parse(await readFile(releasePath, "utf8"));
const tags = fetchDistTags(pkg.name);
const version = planDesktopVersion(pkg.version, tags);
const build = release.buildNumber + 1;

// The release workflow refuses a build without a changelog section, so the
// Unreleased section is renamed after this build in both languages. Work it out
// before writing anything, so a changelog problem leaves the checkout untouched.
const date = new Date().toISOString().slice(0, 10);
const changelogs = [];
for (const [language, path] of Object.entries(changelogPaths)) {
  changelogs.push({ path, text: promoteUnreleased(await readFile(join(root, path), "utf8"), { language, build, version, date }) });
}

const npm = npmCommand(["version", version, "--no-git-tag-version", "--allow-same-version", "--ignore-scripts"]);
execFileSync(npm.file, npm.args, { cwd: root, stdio: "inherit" });
release.buildNumber = build;
await writeFile(releasePath, JSON.stringify(release, null, 2) + "\n");
for (const { path, text } of changelogs) if (text) await writeFile(join(root, path), text);
console.log(`npm latest ${tags.latest}, alpha ${tags.alpha ?? "none"} → desktop-v${version}-b${build}`);
const missing = changelogs.filter(value => !value.text).map(value => value.path);
if (missing.length) console.warn(`No "Unreleased" section in ${missing.join(" and ")}: add a {#build-${build}} section by hand, or the release workflow will stop.`);
console.log("Review the changelog sections and the home page's release badge (docs/en/index.md, docs/zh/index.md), update the README and docs/desktop.md release links, then commit package.json, package-lock.json, desktop/release.json and the docs.");
