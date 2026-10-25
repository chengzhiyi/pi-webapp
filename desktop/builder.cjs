const pkg = require("../package.json");
const release = require("./release.json");

module.exports = {
  appId: "dev.pi.webapp",
  productName: release.productName,
  executableName: release.productName,
  buildVersion: `${release.buildNumber}.0.0`,
  electronVersion: pkg.devDependencies.electron,
  directories: { app: "desktop", output: "desktop-release" },
  extraMetadata: { version: pkg.version },
  files: ["main.mjs", "backend.mjs", "downloads.mjs", "managed-release.mjs", "release-version.mjs", "connect.mjs", "updater.mjs", "update-release.mjs", "update-native.mjs", "package.json", "release.json", "icons/icon.png", "!node_modules{,/**/*}"],
  extraResources: [{ from: ".desktop/runtime", to: "runtime", filter: ["**/*"] }],
  asar: true,
  npmRebuild: false, // Native modules live beside the standalone Node runtime, not in Electron.
  nodeGypRebuild: false,
  artifactName: `pi-\${version}-desktop.${release.buildNumber}-\${os}-\${arch}.\${ext}`,
  // Test builds still need a complete resource seal, not Electron's leftover linker signature.
  // Only an explicitly selected publisher identity may replace the ad-hoc default.
  mac: { icon: "desktop/icons/icon.icns", category: "public.app-category.developer-tools", target: ["dmg", "zip"],
    identity: process.env.CSC_NAME || "-", hardenedRuntime: true, strictVerify: true },
  win: { icon: "desktop/icons/icon.ico", target: ["nsis"] },
  nsis: { oneClick: false, allowToChangeInstallationDirectory: true },
  linux: { icon: "desktop/icons/icon.png", target: ["AppImage"], category: "Development" },
};
