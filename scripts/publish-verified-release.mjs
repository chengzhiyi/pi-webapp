import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { sha256 } from "./sentry-release.mjs";

const manifest = JSON.parse(await readFile(".ci/release/pack.json", "utf8"));
if (manifest.length !== 1 || !/^[\w.-]+\.tgz$/.test(manifest[0]?.filename)) throw new Error("Invalid verified package filename");
const tarball = resolve(".ci/release", manifest[0].filename);
const verified = JSON.parse(await readFile(".ci/release/verified.json", "utf8"));
if (verified.filename !== manifest[0].filename || verified.sha256 !== sha256(await readFile(tarball)) || !/^[a-f0-9]{32}$/.test(verified.nodeEventId) || !/^[a-f0-9]{32}$/.test(verified.browserEventId)) throw new Error("The package has no matching successful Sentry verification receipt");
execFileSync("npm", ["publish", tarball, "--ignore-scripts"], { stdio: "inherit" });
