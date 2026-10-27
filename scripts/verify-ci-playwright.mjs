// The browser jobs use a digest-pinned Playwright image. Fail closed on package /
// image drift, a missing executable, native library or unusable browser. Never
// repair the environment with an online install: that reintroduces apt long tails.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { chromium } from "@playwright/test";

const require = createRequire(import.meta.url);
const pkg = require("@playwright/test/package.json");
const manifest = JSON.parse(await readFile(join(dirname(require.resolve("playwright-core/package.json")), "browsers.json"), "utf8"));
const expected = manifest.browsers.find(browser => browser.name === "chromium");
assert.ok(expected?.browserVersion, "The installed Playwright must pin a Chromium version");
assert.equal(process.versions.node.split(".")[0], "24", "Browser verification must use Node 24");
const browser = await chromium.launch({ headless: true, timeout: 30_000 });
try {
  assert.equal(browser.version(), expected.browserVersion, "Preinstalled Chromium does not match the lockfile's Playwright");
  const page = await browser.newPage();
  await page.setContent('<main id="probe">browser ready / 中文</main>');
  assert.equal(await page.locator("#probe").textContent(), "browser ready / 中文");
  assert.equal(await page.evaluate(() => 20 + 22), 42);
  console.log(JSON.stringify({ playwright: pkg.version, chromium: browser.version(), revision: expected.revision, node: process.version, platform: process.platform, arch: process.arch, browsersPath: process.env.PLAYWRIGHT_BROWSERS_PATH ?? "default" }));
} finally {
  await browser.close();
}
