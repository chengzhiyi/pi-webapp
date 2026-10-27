# CI verification and release browsers

`CI and npm publish` keeps `verify` as the aggregate required check. Its browser
matrix has three disjoint file groups, each with **one worker**:

- `general`: all non-hosted browser tests;
- `hosted`: hosted tests except the stress file, plus the separate public npm
  cross-version upgrade check;
- `stress`: `hosted-stress.spec.ts`, retaining all 20 warmups, 50 measured cycles,
  memory/lifecycle assertions and measurement attachments.

The group helper partitions by filename (including future files), not title.
Local `playwright.config.ts` still discovers the entire suite. The matrix has
`fail-fast: false`; `verify` fails on any failed, skipped or cancelled group.
Both hosted and stress reports must pass `verify-hosted-browser-results.mjs`.
Stress cannot pass by skipping because a fixture or `HOSTED_STRESS=1` is missing;
the checker requires the named stress measurement to have one clean first run.
The hosted checker still requires both production lifecycle viewport cases and
rejects shutdown failures. Evidence is uploaded separately for each group.

## Release probes avoid apt mirror latency

Browser regression/GC tests continue to install the lockfile-pinned Playwright
Chromium and its dependencies. Publishing instead uses Chrome already installed
on the `ubuntu-24.04` runner, via `PI_WEB_TEST_CHROME=true` in the disabled-telemetry
package verification step. This avoids a serialized `playwright install --with-deps`
apt download (11m24s in run 40331021569). It does not change the browser used for
performance measurements or relax any release verification.

`node scripts/verify-ci-chrome.mjs` launches the same Chrome channel, renders a
page, executes JavaScript and logs browser/Node versions. It runs in the general
PR job **before** Playwright installs dependencies and again before package
verification. A missing Chrome binary or shared library fails the job; there is
no silent apt fallback, skipped verification or `continue-on-error`. A runner
image update may change Chrome's version; inspect the preflight log when debugging.

Publishing still selects its version under the existing serialized release job,
checks/tests it, keeps private source maps locally, packs without rebuilding,
verifies that the packaged Node/browser telemetry stays disabled without contacting
Sentry, then publishes that same tarball. The browser-install optimization does not
re-enable telemetry or require Sentry credentials.

## Local checks

```sh
node --experimental-strip-types --test test/browser-ci-groups.test.ts test/hosted-browser-results.test.ts
node scripts/verify-ci-chrome.mjs # Requires installed Google Chrome.
actionlint .github/workflows/ci.yml
PI_WEB_BROWSER_GROUP=stress npx playwright test --config=playwright.ci.config.ts --list
```

For real runs, `scripts/prepare-hosted-ci-fixtures.mjs` validates immutable public
fixture integrities and writes all required environment variables to `GITHUB_ENV`.
Compare CI wall time, installation p95, test discovery and total runner minutes
after rollout. Rough 10-minute (apt avoidance) / 8-minute (plus stress isolation)
estimates from the original run are not measured performance guarantees.
