import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { planRelease, releaseChannel } from "../scripts/release-plan.mjs";

test("main publishes stable, alpha publishes preview, all other refs fail closed", () => {
  assert.equal(releaseChannel("refs/heads/main"), "stable");
  assert.equal(releaseChannel("refs/heads/alpha"), "alpha");
  for (const ref of [undefined, "refs/heads/feature/test", "refs/pull/1/merge", "refs/tags/v1.0.0"]) assert.throws(() => releaseChannel(ref));
});

test("alpha advances only its sequence, stable consumes the release base", () => {
  const tags = { latest: "0.1.29" };
  assert.deepEqual(planRelease("0.1.27", tags, "alpha"), { version: "0.1.30-alpha.1", tag: "alpha", channel: "alpha" });
  const alpha = { ...tags, alpha: "0.1.30-alpha.9" };
  assert.equal(planRelease("0.1.27", alpha, "alpha").version, "0.1.30-alpha.10");
  assert.equal(planRelease("0.1.27", alpha, "stable").version, "0.1.30");
  assert.equal(planRelease("0.1.30-alpha.10", alpha, "stable").version, "0.1.30");
  assert.equal(planRelease("0.1.27", { latest: "0.1.30", alpha: "0.1.30-alpha.10" }, "alpha").version, "0.1.31-alpha.1");
});

test("an explicit minor target and a stable hotfix do not move preview backwards", () => {
  const tags = { latest: "0.1.29", alpha: "0.2.0-alpha.4" };
  assert.equal(planRelease("0.2.0", tags, "alpha").version, "0.2.0-alpha.5");
  assert.equal(planRelease("0.2.0", tags, "stable").version, "0.2.0");
  assert.equal(planRelease("0.1.27", tags, "stable").version, "0.1.30");
  assert.equal(planRelease("0.1.27", { ...tags, latest: "0.1.30" }, "alpha").version, "0.2.0-alpha.5");
  assert.equal(planRelease("0.3.0", tags, "alpha").version, "0.3.0-alpha.1");
  assert.throws(() => planRelease("0.2.0", { latest: "0.1.29", alpha: "0.2.0-beta.1" }, "alpha"));
  assert.throws(() => planRelease("0.2.0", { latest: "0.2.0-alpha.1" }, "stable"));
  assert.throws(() => planRelease("0.2.0", tags, "typo"));
});

test("workflow validates both branches, pins release source, and never writes version commits", async () => {
  const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.equal((workflow.match(/branches: \[main, alpha\]/g) ?? []).length, 2);
  assert.match(workflow, /github.event_name != 'pull_request'/);
  assert.match(workflow, /ref: \$\{\{ github.sha \}\}/);
  assert.doesNotMatch(workflow, /git push|git commit|contents: write/);
  const publish = await readFile(new URL("../scripts/publish-verified-release.mjs", import.meta.url), "utf8");
  assert.match(publish, /"--tag", plan.tag/);
  assert.match(publish, /plan.sourceCommit !== process.env.GITHUB_SHA/);
  assert.match(publish, /sha256\(await readFile\(tarball\)\)/);
});
