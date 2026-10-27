// Both PR verification and publishing exercise the release probe's Chrome channel.
// Fail closed if a runner image loses Chrome or its shared-library dependencies;
// do not silently fall back to an apt install or skip live Sentry verification.
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const browser = await chromium.launch({ channel: "chrome", headless: true, timeout: 30_000 });
try {
  const page = await browser.newPage();
  await page.setContent('<main id="probe">release browser ready</main>');
  assert.equal(await page.locator("#probe").textContent(), "release browser ready");
  assert.equal(await page.evaluate(() => 20 + 22), 42);
  console.log(`Release Chrome preflight passed: ${browser.version()} (${process.platform}/${process.arch}, Node ${process.version})`);
} finally {
  await browser.close();
}
