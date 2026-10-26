import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { browserCIGroup } from "./helpers/browser-ci-groups.ts";

const hosted = browserCIGroup("hosted").testMatch as RegExp;
const ignored = browserCIGroup("general").testIgnore as RegExp;

test("CI partitions every browser file exactly once without changing local discovery", async () => {
  const files = (await readdir(new URL("./browser/", import.meta.url))).filter(file => /\.(spec|test)\.[cm]?[jt]sx?$/.test(file));
  const groups = { general: [] as string[], hosted: [] as string[] };
  for (const file of files) {
    const path = `/repo/test/browser/${file}`;
    const inHosted = hosted.test(path), inGeneral = !ignored.test(path);
    assert.equal(Number(inHosted) + Number(inGeneral), 1, file);
    groups[inHosted ? "hosted" : "general"].push(file);
  }
  assert.ok(groups.general.length > 0 && groups.hosted.length > 0);
  for (const file of ["hosted-stress.spec.ts", "hosted-production.spec.ts", "hosted-npm.spec.ts"]) assert.ok(groups.hosted.includes(file));
  for (const file of ["terminal.spec.ts", "conversation-activity.spec.ts"]) assert.ok(groups.general.includes(file));
  assert.equal(groups.general.length + groups.hosted.length, files.length);
  const localConfig = await readFile(new URL("../playwright.config.ts", import.meta.url), "utf8");
  assert.doesNotMatch(localConfig, /browserCIGroup|PI_WEB_BROWSER_GROUP|testIgnore|testMatch/);
});

test("new files, nested paths and Windows separators cannot fall between groups", () => {
  for (const path of ["hosted-new.spec.ts", "/test/browser/nested/hosted-new.test.ts", "C:\\repo\\test\\browser\\hosted-new.spec.ts", "/test/hosted-new.spec.mts"]) {
    assert.ok(hosted.test(path), path); assert.ok(ignored.test(path), path);
  }
  for (const path of ["/hosted-folder/terminal.spec.ts", "/test/not-hosted-production.spec.ts", "/test/new.test.ts", "/test/nested/chat.spec.ts"]) {
    assert.ok(!hosted.test(path), path); assert.ok(!ignored.test(path), path);
  }
  for (const mode of [undefined, "", "typo", "all"]) assert.throws(() => browserCIGroup(mode), /must be general or hosted/);
});

test("CI reuses hosted evidence, aggregates fail-closed, and only cancels obsolete PR checks", async () => {
  const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(workflow, /group: \[general, hosted\]/);
  assert.match(workflow, /fail-fast: false/);
  assert.match(workflow, /PLAYWRIGHT_JSON_OUTPUT_NAME: \.ci\/browser\/report\.json/);
  assert.match(workflow, /playwright test --config=playwright\.ci\.config\.ts --reporter=line,json/);
  assert.match(workflow, /verify-hosted-browser-results\.mjs \.ci\/browser\/report\.json/);
  assert.doesNotMatch(workflow, /playwright test hosted- --reporter/);
  assert.match(workflow, /HOSTED_NPM_UPGRADE_FROM: '0\.1\.0'/);
  assert.match(workflow, /  verify:\n    if: always\(\)\n    needs: \[verify-core, browser\]/);
  assert.match(workflow, /test "\$CORE_RESULT" = success/);
  assert.match(workflow, /test "\$BROWSER_RESULT" = success/);
  assert.match(workflow, /protocol_published: \$\{\{ needs.verify-core.outputs.protocol_published \}\}/);
  assert.match(workflow, /needs: \[verify, platform-smoke\]/);
  assert.equal((workflow.match(/cancel-in-progress: \$\{\{ github.event_name == 'pull_request' \}\}/g) ?? []).length, 3);
  assert.equal((workflow.match(/github.event.pull_request.number \|\| github.run_id/g) ?? []).length, 3);
  assert.match(workflow, /group: pi-webapp-npm-publish\n      cancel-in-progress: false/);
});
