import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { docsUrl, isDocsAddress, issuesUrl } from "../docs-links.mjs";

const builder = createRequire(import.meta.url)("../builder.cjs");

test("the docs link helper ships inside the desktop application", () => {
  assert.ok(builder.files.includes("docs-links.mjs"));
});

test("documentation pages follow the interface language", () => {
  assert.equal(docsUrl("home", "en"), "https://pi.emath.top/");
  assert.equal(docsUrl("quickStart", "en-US"), "https://pi.emath.top/getting-started");
  assert.equal(docsUrl("home", "zh"), "https://pi.emath.top/zh/");
  assert.equal(docsUrl("troubleshooting", "zh-CN"), "https://pi.emath.top/zh/troubleshooting");
  assert.equal(issuesUrl, "https://github.com/chengzhiyi/pi-webapp/issues");
});

test("only the official documentation origin skips the external-link prompt", () => {
  assert.ok(isDocsAddress("https://pi.emath.top/zh/troubleshooting"));
  for (const value of ["http://pi.emath.top/", "https://pi.emath.top.example.com/", "https://evil.example/https://pi.emath.top/", "https://github.com/chengzhiyi/pi-webapp", "not a url", null]) {
    assert.equal(isDocsAddress(value), false, String(value));
  }
});

test("the native Help menu opens the official documentation", async () => {
  const source = await readFile(new URL("../main.mjs", import.meta.url), "utf8");
  assert.match(source, /role: "help"/);
  for (const page of ["home", "quickStart", "troubleshooting"]) assert.ok(source.includes(`docsUrl("${page}"`), page);
  assert.ok(source.includes("openInBrowser(issuesUrl)"));
});
