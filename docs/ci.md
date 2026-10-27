# CI verification and release browsers

`CI and npm publish` retains `verify` as the aggregate required check. The browser
matrix has four disjoint filename groups on independent runners, each with
**one worker**:

- `general`: files that start with neither `hosted-` nor `workspace-`;
- `workspace`: all `workspace-*` browser files;
- `hosted`: `hosted-*` files except the stress file, plus the separate public npm
  cross-version upgrade check;
- `stress`: `hosted-stress.spec.ts`, retaining all 20 warmups, 50 measured cycles,
  memory/lifecycle assertions and measurement attachments.

The group helper partitions by filename, including future/nested files and Windows
paths. Local `playwright.config.ts` still discovers the entire suite unchanged.
The former general group took 214–222 seconds; workspace cases accounted for about
120 seconds of it. Splitting files across isolated runners reduces that serial
cost without enabling concurrent workers in process-env/GC-sensitive tests.
The roughly three-minute stress test remains a critical-path floor.

## Browser environment: no per-run apt installation

Browser jobs retain `ubuntu-24.04` and its native browser libraries, fonts and
compiler toolchain. `actions/setup-node` selects Node 24; `npm ci` installs the
lockfile-pinned test package and compiles the required native PTY. Then
`npx playwright install --only-shell chromium` downloads only the pinned headless
shell and FFmpeg, not the unused full Chrome binary, and never runs apt.
Tests already use that default headless shell; no browser channel is substituted.

`node scripts/verify-ci-playwright.mjs` launches it, checks the actual version
against the installed package's `browsers.json`, renders a page and executes
JavaScript. It logs Playwright/Chromium/revision/Node/platform identity. Missing or
incompatible browsers/libraries fail the job; there is no silent apt repair,
Chrome substitution, skipped verification or `continue-on-error`. The full suite
(including packaged font tests and stress) must pass before publishing. Regression
tests require package.json, lockfile Playwright and playwright-core versions to
agree. Upgrade all three together and repeat the complete browser/stress validation.

This removes the unstable `playwright install --with-deps chromium` operation:
in runs 40515822039 / 40515675727 it took 257 / 461 seconds in the critical job,
while other runners took 22–28 seconds. Logs attribute the long tail to apt
packages (25.9 MB in 3m43s / 7m22s), not Chromium downloads or failed tests.
An initial real-CI experiment with the official Playwright image failed because
it lacks `make`, needed to build `node-pty`; it also pulls about 912 MiB compressed.
The final workflow deliberately retains the normal runner instead of adding apt
compiler installs to that image or skipping the native dependency. The failed
experiment's aggregate correctly prevented publication (run 40520459722).

The browser remains Chromium 153.0.8010.12 (Playwright revision 1243), and native
libraries now come from the runner image rather than apt upgrades on every run.
Keep stress thresholds and all 70 cycles; retain environment identity with
measurements and compare full-suite behavior rather than assuming equivalence.

## Release Chrome stays on the release runner

Core verification, browser tests and publishing all use `ubuntu-24.04`. `node scripts/verify-ci-chrome.mjs` runs in core (including PRs) and in
publish: it exercises the same runner Chrome channel used by package verification,
before any Playwright dependency installation could mask a missing shared library.
Missing Chrome or shared libraries fail closed; there is no apt fallback.

Publishing still chooses the version under the serialized release lock, checks,
builds and tests that source, keeps private source maps locally, packs without
rebuilding, verifies packaged Node/browser telemetry is disabled without Sentry
access, and publishes that same tarball. Those checks are not removed to save time.

## Acceptance, evidence and cancellation

The matrix has `fail-fast: false`; `verify` requires successful core and **all four**
browser groups. Failed, skipped or cancelled jobs cannot turn the aggregate green.
Hosted and stress reports must pass `verify-hosted-browser-results.mjs`: hosted
requires both production viewport lifecycle cases and acknowledged shutdown;
stress requires its named measurement once, without skips or retries.

Each group runs once with line + JSON reporters and uploads
`browser-evidence-{general,workspace,hosted,stress}` with `.ci/browser/report.json`
and `test-results`. The public `0.1.0` → `0.1.1` update remains a distinct check.

Only superseded checks on the same PR/group are cancelled. Branch/release runs
remain unique; publication retains `cancel-in-progress: false`. Source checkout,
protocol publication/bootstrap, platform smoke and the release archive gates are
unchanged. There is no workflow-wide cancellation or cross-branch release dedup.

## Local verification and performance validation

```sh
node --experimental-strip-types --test test/browser-ci-groups.test.ts test/hosted-browser-results.test.ts
actionlint .github/workflows/ci.yml
node scripts/verify-ci-playwright.mjs # Requires matching installed Chromium + Node 24.
node scripts/verify-ci-chrome.mjs     # Requires installed Google Chrome.
PI_WEB_BROWSER_GROUP=workspace npx playwright test --config=playwright.ci.config.ts --list
```

For real runs, `scripts/prepare-hosted-ci-fixtures.mjs` validates immutable public
fixture integrities and exports the exact fixture paths and stress configuration.
Compare the union of four `--list --reporter=json` outputs against local discovery:
every test identity must appear exactly once.

After rollout, collect 10–20 samples of runner initialization, dependency setup,
group execution, publication and total runner wall time; compare p50/p95 and flaky
rates. Separate run-created→last-job-completed from GitHub's run timing value:
the sampled runs have unexplained 4–5 minute differences after the final job, not
attributable to visible steps. The optimization targets observable execution and
does not promise to remove that provider-state delay. Rough 6–7 minute end-to-end
job-path estimates are targets, not measured guarantees.
