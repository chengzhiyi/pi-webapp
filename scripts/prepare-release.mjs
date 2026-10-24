import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { planRelease, releaseChannel } from "./release-plan.mjs";

// No implicit stable fallback: an accidental branch must never publish to latest.
const channel = releaseChannel(process.env.GITHUB_REF);
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const result = JSON.parse(execFileSync("npm", ["view", pkg.name, "dist-tags", "--json", "--prefer-online"], { encoding: "utf8" }));
const tags = Array.isArray(result) && result.length === 1 ? result[0] : result;
const plan = { ...planRelease(pkg.version, tags, channel), sourceCommit: process.env.GITHUB_SHA };
execFileSync("npm", ["version", plan.version, "--no-git-tag-version", "--allow-same-version"], { stdio: "inherit" });
execFileSync("npm", ["pkg", "set", `pi.image=https://cdn.jsdelivr.net/npm/${pkg.name}@${plan.version}/assets/cover-webapp.png`], { stdio: "inherit" });
mkdirSync(".ci/release", { recursive: true });
writeFileSync(".ci/release/plan.json", JSON.stringify(plan, null, 2));
console.log(`Publishing ${pkg.name}@${plan.version} to ${plan.tag} (${plan.sourceCommit})`);
