# CI verification layout

See [CI verification and release browsers](ci.md) for the current environment,
measurement methodology and local commands.

`CI and npm publish` validates PRs and pushes to `main` / `alpha`:

- `verify-core`: protocol resolution, runner Chrome preflight, type checking,
  build, Node/desktop tests and alpha bootstrap identity verification.
- `browser (general)`, `browser (workspace)`, `browser (hosted)` and
  `browser (stress)`: four isolated, single-worker file groups. The digest-pinned
  official Playwright image supplies the matching Chromium/native libraries/fonts;
  Node 24 and the lockfile remain authoritative. A mandatory live browser preflight
  fails closed instead of repairing the environment with an online apt install.
- `verify`: the existing required-check name; succeeds only if core and all four
  browser jobs succeed, forwarding core's protocol-publication output.
- `platform-smoke`: macOS / Windows built-in-only checks, without npm installation.
- `publish`: still requires `verify`, `platform-smoke`, a non-PR main/alpha ref and
  a published protocol. Exact-source checkout, serialized version selection,
  checks/build/tests, exact tarball and disabled-telemetry verification remain.

## No missing or duplicate tests

`playwright.ci.config.ts` extends the default config. `workspace-*` files belong
to workspace, `hosted-stress.*` to stress, other `hosted-*` to hosted, and all other
files to general. New/nested files join exactly one group. A missing/unknown group
fails immediately. Local `npm run test:browser` still discovers the full suite.

Each group runs once with line + JSON reporters. Hosted/stress acceptance reads
**that execution's report**, rather than rerunning a subset. Missing/malformed
reports, global errors, non-diagnostic skips, retries and failed real shutdowns
reject acceptance. The separate public `0.1.0` → `0.1.1` update exercises a distinct
path. The stress measurement still includes 20 warmups plus 50 measured cycles;
its test and resources are not parallelized with other files.

Artifacts are `browser-evidence-{general,workspace,hosted,stress}`, containing
`.ci/browser/report.json` and `test-results`. Set
`PI_WEB_BROWSER_GROUP=general|workspace|hosted|stress` and use
`--config=playwright.ci.config.ts` to reproduce a group.

## Cancellation and release safety

Core, browser and platform-smoke cancel superseded checks only for the same PR
(and matrix group). Non-PR concurrency keys use unique run IDs. There is no
workflow-wide cancellation, and publish retains its non-cancelling lock. A PR
verification run neither merges code nor publishes a package.
