import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { npmCommand } from "../bin/npm-command.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const target = join(root, "desktop", "runtime-manifest");
await mkdir(target, { recursive: true });
const manifest = { name: "pi-webapp-runtime", version: "1.0.0", private: true, type: "module",
  dependencies: { ...pkg.dependencies, "@earendil-works/pi-ai": pkg.devDependencies["@earendil-works/pi-ai"],
    "@earendil-works/pi-coding-agent": pkg.devDependencies["@earendil-works/pi-coding-agent"] } };
// Seed with the main lock so the initial runtime uses the same dependency resolutions.
const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
lock.name = manifest.name;
lock.version = manifest.version;
lock.packages[""] = manifest;
await writeFile(join(target, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
await writeFile(join(target, "package-lock.json"), JSON.stringify(lock, null, 2) + "\n");
const npm = npmCommand(["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"]);
execFileSync(npm.file, npm.args, { cwd: target, stdio: "inherit" });
console.log("Desktop runtime lock refreshed. Review and commit both runtime-manifest files.");
