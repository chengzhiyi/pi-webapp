import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { sha256 } from "./sentry-release.mjs";
import { releaseChannel } from "./release-plan.mjs";
import { isAlphaVersion, isStableVersion } from "../desktop/release-version.mjs";

const manifest = JSON.parse(await readFile(".ci/release/pack.json", "utf8"));
if (manifest.length !== 1 || !/^[\w.-]+\.tgz$/.test(manifest[0]?.filename)) throw new Error("Invalid verified package filename");
const tarball = resolve(".ci/release", manifest[0].filename);
const verified = JSON.parse(await readFile(".ci/release/verified.json", "utf8"));
if (verified.filename !== manifest[0].filename || verified.sha256 !== sha256(await readFile(tarball)) || !/^[a-f0-9]{32}$/.test(verified.nodeEventId) || !/^[a-f0-9]{32}$/.test(verified.browserEventId)) throw new Error("The package has no matching successful Sentry verification receipt");
const plan = JSON.parse(await readFile(".ci/release/plan.json", "utf8"));
const channel = releaseChannel(process.env.GITHUB_REF);
if (plan.channel !== channel || plan.sourceCommit !== process.env.GITHUB_SHA || plan.version !== manifest[0].version
    || plan.tag !== (channel === "alpha" ? "alpha" : "latest")
    || !(channel === "alpha" ? isAlphaVersion(plan.version) : isStableVersion(plan.version))) throw new Error("Release plan does not match the verified package and source branch");
// Verification jobs may finish out of order. Never let an older workflow
// publish old code with a higher version after a newer workflow has completed.
const head = execFileSync("git", ["ls-remote", "origin", process.env.GITHUB_REF], { encoding: "utf8" }).trim().split(/\s+/)[0];
if (head !== plan.sourceCommit) throw new Error("Release source is no longer the branch head; publish the newer verified workflow instead");
execFileSync("npm", ["publish", tarball, "--tag", plan.tag, "--ignore-scripts"], { stdio: "inherit" });
