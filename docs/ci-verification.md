# CI verification layout

`CI and npm publish` validates PRs and pushes to `main` / `alpha`.

- `verify-core`: protocol resolution, type checking, build, Node and desktop tests.
- `browser (general)` and `browser (hosted)`: separate runners, each with one Playwright worker. They build the same checked-out source and use the same integrity-pinned published fixtures as core verification. The existing protocol bootstrap path is retained.
- `verify`: the existing required-check name, now a fail-closed aggregate. It succeeds only when core and **both** browser groups succeed. Its protocol-publication output is forwarded from core.
- `platform-smoke`: the existing macOS / Windows built-in-only checks.
- `publish`: still requires `verify`, `platform-smoke`, a non-PR main/alpha ref and a published protocol. Exact-source checkout, release-archive/Sentry verification and non-cancelling publication concurrency are unchanged.

## No duplicate hosted execution

`playwright.ci.config.ts` extends the default config. A filename starting with `hosted-` belongs to the hosted job; all other default-discovered files belong to general. New tests automatically join exactly one group. A missing/unknown group fails immediately. Local `npm run test:browser` still discovers the entire suite unchanged.

Each group runs once with line + JSON reporters. The hosted job applies `verify-hosted-browser-results.mjs` to **that execution's report**, rather than rerunning the subset. Missing/malformed reports, global errors, non-diagnostic skips, retries and failed real shutdowns still reject acceptance. The separate public `0.1.0` → `0.1.1` update run remains because it exercises a distinct path, and the 70-cycle stress test remains enabled. Neither test counts nor stress cycles are reduced.

Evidence artifacts are named `browser-evidence-general` and `browser-evidence-hosted`; each contains `.ci/browser/report.json` and failure traces/screenshots in `test-results`. Use the default config when investigating the full suite locally, or set `PI_WEB_BROWSER_GROUP=general|hosted` and pass `--config=playwright.ci.config.ts` to reproduce a group.

## Cancellation and release safety

Core, browser and platform-smoke jobs cancel superseded checks only for the same PR (and the same matrix group). Non-PR runs use unique run IDs, so a newer branch push cannot cancel an in-flight release verification. There is deliberately no workflow-wide cancellation and the `publish` job retains its original `cancel-in-progress: false` group. No code is merged or published merely by a PR verification run.

## Performance expectations

Before this change, the sampled PR8 verification took 17m44s, including 9m42s for the full browser suite and then 5m36s rerunning its hosted subset. Eliminating the duplicate execution alone removes approximately that 5m36s of browser work. Parallel disjoint groups additionally shorten the critical path, at the cost of installing/building on separate runners. Actual wall-time improvements depend on runner availability and test durations; CI measurements, not these estimates, determine the outcome.
