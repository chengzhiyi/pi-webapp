import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { npmCommand } from "../bin/npm-command.mjs";
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
const npm = npmCommand(["version", version, "--no-git-tag-version", "--allow-same-version", "--ignore-scripts"]);
execFileSync(npm.file, npm.args, { cwd: root, stdio: "inherit" });
release.buildNumber += 1;
await writeFile(releasePath, JSON.stringify(release, null, 2) + "\n");
console.log(`npm latest ${tags.latest}, alpha ${tags.alpha ?? "none"} → desktop-v${version}-b${release.buildNumber}`);
console.log("Update the README and docs/desktop.md release links, then commit package.json, package-lock.json and desktop/release.json.");
