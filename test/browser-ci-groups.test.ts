import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { browserCIGroup } from "./helpers/browser-ci-groups.ts";

const names = ["general", "hosted", "stress"] as const;
function matches(group: string, path: string) {
  const config = browserCIGroup(group);
  return (!config.testMatch || (config.testMatch as RegExp).test(path)) && (!config.testIgnore || !(config.testIgnore as RegExp).test(path));
}

test("CI partitions every browser file exactly once without changing local discovery", async () => {
  const files = (await readdir(new URL("./browser/", import.meta.url))).filter(file => /\.(spec|test)\.[cm]?[jt]sx?$/.test(file));
  const groups = { general: [] as string[], hosted: [] as string[], stress: [] as string[] };
  for (const file of files) {
    const included = names.filter(group => matches(group, `/repo/test/browser/${file}`));
    assert.equal(included.length, 1, file);
    groups[included[0]!].push(file);
  }
  assert.ok(groups.general.length > 0 && groups.hosted.length > 0);
  assert.deepEqual(groups.stress, ["hosted-stress.spec.ts"]);
  for (const file of ["hosted-production.spec.ts", "hosted-npm.spec.ts"]) assert.ok(groups.hosted.includes(file));
  for (const file of ["terminal.spec.ts", "conversation-activity.spec.ts"]) assert.ok(groups.general.includes(file));
  assert.equal(Object.values(groups).flat().length, files.length);
  const localConfig = await readFile(new URL("../playwright.config.ts", import.meta.url), "utf8");
  assert.doesNotMatch(localConfig, /browserCIGroup|PI_WEB_BROWSER_GROUP|testIgnore|testMatch/);
});

test("new files, nested paths and Windows separators cannot fall between groups", () => {
  for (const [group, paths] of Object.entries({
    hosted: ["hosted-new.spec.ts", "/test/browser/nested/hosted-new.test.ts", "C:\\repo\\test\\browser\\hosted-new.spec.ts", "/test/hosted-new.spec.mts"],
    stress: ["hosted-stress.spec.ts", "/test/browser/nested/hosted-stress.test.ts", "C:\\repo\\test\\browser\\hosted-stress.spec.ts"],
    general: ["/hosted-folder/terminal.spec.ts", "/test/not-hosted-production.spec.ts", "/test/new.test.ts", "/test/nested/chat.spec.ts"],
  })) {
    for (const path of paths) assert.deepEqual(names.filter(name => matches(name, path)), [group], path);
  }
  for (const mode of [undefined, "", "typo", "all"]) assert.throws(() => browserCIGroup(mode), /must be general, hosted or stress/);
});

test("CI reuses hosted evidence, aggregates fail-closed, and only cancels obsolete PR checks", async () => {
  const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(workflow, /group: \[general, hosted, stress\]/);
  assert.match(workflow, /fail-fast: false/);
  assert.match(workflow, /PLAYWRIGHT_JSON_OUTPUT_NAME: \.ci\/browser\/report\.json/);
  assert.match(workflow, /playwright test --config=playwright\.ci\.config\.ts --reporter=line,json/);
  assert.match(workflow, /verify-hosted-browser-results\.mjs \.ci\/browser\/report\.json "\$\{\{ matrix.group \}\}"/);
  assert.match(workflow, /if: always\(\) && matrix.group != 'general'/);
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

test("publish avoids apt installs but keeps Chrome and exact tarball verification mandatory", async () => {
  const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const browser = workflow.split("\n  browser:")[1]!.split("\n  verify:")[0]!;
  const publish = workflow.split("\n  publish:")[1]!;
  for (const job of [browser, publish]) {
    assert.match(job, /runs-on: ubuntu-24\.04/);
    assert.match(job, /run: node scripts\/verify-ci-chrome\.mjs/);
  }
  assert.match(browser, /if: matrix.group == 'general'\n        timeout-minutes: 1/);
  assert.match(browser, /npx playwright install --with-deps chromium/); // Benchmarks still use pinned Chromium.
  assert.doesNotMatch(publish, /playwright install|continue-on-error/);
  assert.match(publish, /PI_WEB_TEST_CHROME: 'true'/);
  assert.match(publish, /ref: \$\{\{ github.sha \}\}/);
  assert.doesNotMatch(publish, /npm run build:sentry|npm run verify:sentry|SENTRY_VERIFY_AUTH_TOKEN/);
  assert.match(browser, /scripts\/verify-sentry-release\.mjs --telemetry-disabled/);
  const stages = ["npm run build", "npm pack --ignore-scripts", "npm run verify:package", "node scripts/verify-ci-chrome.mjs", "node scripts/verify-sentry-release.mjs --telemetry-disabled --pack-manifest .ci/release/pack.json", "node scripts/publish-verified-release.mjs"];
  let previous = -1;
  for (const stage of stages) {
    const index = publish.indexOf(stage);
    assert.ok(index > previous, `${stage} must remain in release verification order`);
    previous = index;
  }
});
