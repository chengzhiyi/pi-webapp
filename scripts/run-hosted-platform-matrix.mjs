// Local/native runner entry. Never dispatches CI, publishes, pushes or cross-packages.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const mode = process.argv[2];
assert.ok(["browser", "desktop"].includes(mode), "Usage: node scripts/run-hosted-platform-matrix.mjs browser|desktop");
assert.equal(process.platform, process.env.ORI41_TARGET_OS, "Explicit target OS must match actual runner");
assert.equal(process.arch, process.env.ORI41_TARGET_ARCH, "Explicit target architecture must match actual runner");
assert.ok(process.env.HOSTED_EXCALIDRAW_TGZ, "Stage the supplied local development archive, do not fetch a registry substitute");
const archive = resolve(process.env.HOSTED_EXCALIDRAW_TGZ);
const sha = createHash("sha256").update(readFileSync(archive)).digest("hex");
assert.equal(sha, "932c697f49d87855d5ddc46786c9d0d8ee7b52f64f95af266c46d18ce84d53d5");
const output = resolve(process.env.ORI41_OUTPUT || `artifacts/ori41/${process.platform}-${process.arch}-${mode}`);
mkdirSync(output, { recursive: true });
const env = { ...process.env, HOSTED_EXCALIDRAW_TGZ: archive };
const steps = [];
function run(name, command, args) {
  const result = spawnSync(command, args, { env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  writeFileSync(resolve(output, `${name}.log`), (result.stdout || "") + (result.stderr || "") + (result.error ? String(result.error) : ""));
  steps.push({ name, status: result.status, signal: result.signal, error: result.error?.message });
  console.log(name, result.status);
  return result.status === 0;
}
// Use node to invoke npm's JS entry; no platform shell interprets paths/arguments.
const npm = resolve(process.env.npm_execpath || (process.platform === "win32" ? resolve(process.execPath, "../node_modules/npm/bin/npm-cli.js") : resolve(process.execPath, "../../lib/node_modules/npm/bin/npm-cli.js")));
const npmRun = (name, ...args) => run(name, process.execPath, [npm, "run", name, ...args]);
if (npmRun("build")) {
  if (mode === "browser") {
    const engine = process.env.ORI41_BROWSER;
    assert.ok(["firefox", "webkit", "chromium"].includes(engine), "Set ORI41_BROWSER to one engine");
    env.PLAYWRIGHT_JSON_OUTPUT_FILE = resolve(output, "results.json");
    // Install official engine first: failure is a failure, never a skip/pass.
    if (run("install-browser", process.execPath, ["node_modules/@playwright/test/cli.js", "install", engine])) {
      run("browser", process.execPath, ["node_modules/@playwright/test/cli.js", "test", "-c", "playwright.hosted-matrix.config.ts", `--project=${engine}`, "--reporter=line,json"]);
      run("strict-lifecycle-gate", process.execPath, ["scripts/verify-hosted-browser-results.mjs", env.PLAYWRIGHT_JSON_OUTPUT_FILE]);
    }
  } else if (npmRun("desktop:prepare") && npmRun("desktop:package", "--", "--dir")) {
    // Native dialogs and OS IME need the separate witnessed checklist, not these probes.
    assert.ok(env.PI_WEB_DESKTOP_EXECUTABLE, "Set executable path for this native target");
    env.PI_WEB_DESKTOP_EXECUTABLE = resolve(env.PI_WEB_DESKTOP_EXECUTABLE);
    run("packaged-baseline", process.execPath, ["--experimental-strip-types", "scripts/smoke-hosted-desktop.mjs"]);
    run("packaged-focus-recovery", process.execPath, ["--experimental-strip-types", "scripts/smoke-hosted-platform.mjs"]);
  }
}
writeFileSync(resolve(output, "runner.json"), JSON.stringify({ platform: process.platform, arch: process.arch, node: process.version, sha256: sha, mode, steps, nativeHumanChecklist: "NOT RUN by automation" }, null, 2));
if (steps.some(step => step.status !== 0)) process.exitCode = 1;
