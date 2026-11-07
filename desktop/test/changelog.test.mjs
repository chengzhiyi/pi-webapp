import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { changelogPaths, changelogSection, promoteUnreleased, releaseChangelog } from "../../scripts/changelog.mjs";

const sample = "# Changelog\n\nIntro.\n\n## Unreleased {#unreleased}\n\n### Highlights\n\n- New thing. See [Files](./workspace-tools#files).\n\n" +
  "## Desktop build 3 · pi 0.1.2 · 2026-01-02 {#build-3}\n\n- Old thing.\n";

test("sections are found by heading anchor and end at the next section", () => {
  assert.equal(changelogSection(sample, "build-3"), "- Old thing.");
  assert.equal(changelogSection(sample, "unreleased"), "### Highlights\n\n- New thing. See [Files](./workspace-tools#files).");
  assert.equal(changelogSection(sample, "build-4"), undefined);
});

test("release notes get absolute site links and no heading anchors", () => {
  const promoted = promoteUnreleased(sample, { language: "en", build: 4, version: "0.1.3", date: "2026-02-03" });
  assert.equal(releaseChangelog(promoted, 4), "### Highlights\n\n- New thing. See [Files](https://pi.emath.top/workspace-tools#files).");
  assert.throws(() => releaseChangelog(sample, 4), /\{#build-4\}/);
  assert.throws(() => releaseChangelog(sample.replace("- Old thing.\n", ""), 3), /non-empty/);
});

test("preparing a build renames Unreleased in each language and refuses a duplicate build", () => {
  const en = promoteUnreleased(sample, { language: "en", build: 4, version: "0.1.3", date: "2026-02-03" });
  assert.match(en, /^## Desktop build 4 · pi 0\.1\.3 · 2026-02-03 \{#build-4\}$/m);
  assert.doesNotMatch(en, /\{#unreleased\}/);
  const zh = promoteUnreleased(sample.replace("## Unreleased", "## 未发布"), { language: "zh", build: 4, version: "0.1.3", date: "2026-02-03" });
  assert.match(zh, /^## 桌面构建 4 · pi 0\.1\.3 · 2026-02-03 \{#build-4\}$/m);
  assert.equal(promoteUnreleased(en, { language: "en", build: 5, version: "0.1.4", date: "2026-02-04" }), undefined);
  assert.throws(() => promoteUnreleased(sample, { language: "en", build: 3, version: "0.1.3", date: "2026-02-03" }), /already has a section/);
});

test("the published changelog has the same sections in both languages", () => {
  const anchors = path => [...readFileSync(new URL(`../../${path}`, import.meta.url), "utf8").matchAll(/^## .*\{#([\w-]+)\}\s*$/gm)].map(match => match[1]);
  const en = anchors(changelogPaths.en);
  assert.ok(en.length > 0);
  assert.deepEqual(anchors(changelogPaths.zh), en);
});
