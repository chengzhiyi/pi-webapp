import { defineConfig } from "@playwright/test";

// Explicit engine coverage; does not redefine product support or imply Safari certification.
export default defineConfig({
  testDir: "./test/browser", fullyParallel: false, workers: 1, timeout: 20_000,
  testMatch: ["hosted-parity.spec.ts", "hosted-production.spec.ts", "hosted-transport.spec.ts", "hosted-viewport-parity-fix.spec.ts", "hosted-update-policy.spec.ts", "hosted-platform-fonts.spec.ts"],
  use: { headless: true, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    { name: "firefox", use: { browserName: "firefox" } },
    { name: "webkit", use: { browserName: "webkit" } },
    { name: "chromium", use: { browserName: "chromium" } },
  ],
});
