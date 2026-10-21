import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectMacAppSignature } from "./desktop-signing.mjs";
import { verifyMacArchives } from "./verify-desktop-archives.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (args.some(arg => arg !== "--dir") || args.length > 1) throw new Error("Usage: npm run desktop:package [-- --dir]. Build on the target OS/architecture.");
const info = JSON.parse(await readFile(join(root, ".desktop", "runtime", "build-info.json"), "utf8"));
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
if (info.platform !== process.platform || info.arch !== process.arch || info.version !== pkg.version) {
  throw new Error("Desktop runtime does not match this host/version; run npm run desktop:prepare again.");
}
const require = createRequire(import.meta.url);
execFileSync(process.execPath, [require.resolve("electron-builder/out/cli/cli.js"), "--config", "desktop/builder.cjs", "--publish", "never", ...args], {
  cwd: root, stdio: "inherit", env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" },
});
if (process.platform === "darwin") {
  const app = join(root, "desktop-release", process.arch === "arm64" ? "mac-arm64" : "mac", "pi.app");
  const signing = await inspectMacAppSignature(app);
  if (!args.includes("--dir")) {
    const release = JSON.parse(await readFile(join(root, "desktop/release.json"), "utf8"));
    const prefix = join(root, "desktop-release", `pi-${pkg.version}-desktop.${release.buildNumber}-mac-${process.arch}`);
    await verifyMacArchives({ dmg: `${prefix}.dmg`, zip: `${prefix}.zip`, signing });
  }
  console.log(`macOS app/archive signature integrity verified (${signing.type}); notarization is NOT claimed.`);
}
