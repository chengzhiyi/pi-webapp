import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/browser", fullyParallel: false, workers: 1, timeout: 20_000,
  use: { browserName: "chromium", headless: true, ...(process.env.PI_WEB_TEST_CHROME === "true" ? { channel: "chrome" } : {}) },
});
