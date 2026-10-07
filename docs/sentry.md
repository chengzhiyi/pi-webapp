# Sentry error collection

Browser and extension error reporting are enabled by default with this built-in public DSN:

```text
https://070c0b7c5ac18d940c294e63ecfa0793@o4506663318716416.ingest.us.sentry.io/4512191040716800
```

Start Pi and run `/web`; no environment configuration is needed. To override the default destination, set `PI_WEB_SENTRY_DSN` in the **Pi process environment**. Pi does not automatically read `.env`; `.env.example` is a configuration reference.

```sh
PI_WEB_SENTRY_DSN='https://PUBLIC_KEY@o123.ingest.sentry.io/123' pi
```

Replace the example with your project's public DSN. `PI_WEB_SENTRY_BROWSER_DSN` and `PI_WEB_SENTRY_NODE_DSN` override the common destination; an explicitly empty override disables that side. An explicitly empty common DSN disables both sides unless a per-side DSN overrides it. Use `PI_WEB_SENTRY_ENABLED=false` to disable both regardless of DSN overrides; disabled SDKs are not loaded and no events are sent. `PI_WEB_SENTRY_ENVIRONMENT` defaults to `production`. Restart Pi after changing runtime configuration. The host's `SENTRY_DSN` is deliberately ignored.

## What is collected

- Browser errors, unhandled rejections, React render failures, HTTP/response parsing failures, invalid NDJSON/protocol events and unexpected connection failures.
- Extension request/workspace/configuration failures, asynchronous Agent and tool failures, and provider-login failures. Fatal exceptions attributable to this extension are best effort; process exit can prevent delivery.
- Sanitized stack locations and causes, build/release versions, runtime/platform, model and session-state summaries, anonymous session identifiers, request/operation IDs and up to 100 semantic breadcrumbs (64 KiB total).

User cancellation, stopping an Agent, normal shutdown, known request validation failures and stale-session conflicts are excluded. Recognized tool validation failures remain as warning events. No conversation, source contents, attachments, login values, request/response bodies, console output or DOM recordings are deliberately collected. Agent/provider error messages are replaced with generic diagnostic labels. Other exception text is scrubbed for credentials, URLs, quoted values (including multiple lines), email addresses and paths. Arbitrary free-form exception messages cannot be classified perfectly; do not put private data in exceptions.

Browser events go directly to the configured Sentry host with no Pi authorization header, cookies or referrer. The authenticated configuration endpoint returns only the public DSN and build metadata. Node reporting uses a private client and explicit scopes without initializing a global SDK or changing Pi's uncaught-error/async-context handling; inherited SDK attachments are discarded before sending.

## Diagnosing a tool failure

For CLI + Codex analysis of existing issues, including classifications and repair decisions, see [Sentry triage](sentry-triage.md). Run `npm run sentry:triage` from the repository after authenticating the Sentry and Codex CLIs.

Both TUI and SDK workspace sessions observe `tool_execution_start/end`. A failed `message_end` is a fallback only: the same tool call is not reported twice. Tool execution behavior and visible results are unchanged.

| Diagnostic field | Meaning |
| --- | --- |
| `toolName`, `toolId` | Standard built-in name, or `custom` with a stable 16-character SHA-256 identifier; private custom tool names are not uploaded. |
| `toolCallId`, `session` | Salted anonymous identities for correlation within the running process. |
| `requestId`, `operationId` | Correlation copied at tool start; `/api/resume` receives a new operation ID. |
| `failureKind`, `errorCode` | Classified reason and recognized code, including `ENOENT`, `EACCES`, or `nonzero_exit`. |
| `exitCode`, `durationMs`, `timeoutMs` | Known process status, monotonic elapsed time, and timeout. Missing evidence stays absent. |
| `diagnosticSource` | `tool_execution_end` or `message_end`. |
| `originalStackAvailable` | Whether the captured failure includes an original exception stack. |
| `errorSummary`, `summaryOmitted`, `summaryOmittedReason` | At most two diagnostic lines / 512 characters, or an explicit explanation of unavailable text. |

`cancelled` and explicit `blocked` results produce breadcrumbs without error events. Recognized `validation`, `not_found`, `permission`, `timeout`, and `process_exit` tool results are warnings. `unknown` failures and actual program exceptions remain errors. Cancellation requires a marked in-progress call or an exact SDK cancellation format; merely clearing a session does not classify its failures as cancelled. A cancellation request does not suppress an independent program exception.

Summaries are reconstructed from recognized diagnostic formats rather than uploading redacted stdout/stderr. For example, `bash: process_exit (nonzero_exit)` carries `Command exited with code 127`; a file failure carries `ENOENT: no such file or directory` and a recognized filesystem operation when available. Paths, arbitrary output, arguments, and error details objects are not uploaded. Unrecognized free text is omitted. Actual tool exception types, stack frames and Error cause chains are retained, but arbitrary exception messages are replaced with a safe diagnostic label.

Pi can convert an exception to a tool-result string before pi-webapp sees it. These events have `originalStackAvailable=false` and **no synthetic observer stack**. Source maps cannot recover a stack that the SDK discarded. The local tool card remains the source of full output; this release adds no diagnostic export or SDK changes.

Result-only errors group by tool identity, failure kind and stable error code; request IDs, release versions, summaries and timestamps do not fragment the issue. Actual exceptions use Sentry's stack-based grouping. The same key controls local rate limiting, so `repeats` counts suppressed events of the same diagnostic class, not necessarily retries of the same call. Unknown causes within the same tool remain grouped because their missing text cannot safely distinguish them.

Breadcrumbs include `agent_start`, `agent_end`, `tool_start`, `tool_end`, `tool_failed`, `tool_cancelled`, `tool_blocked`, `cancel` and `resume`. Do not infer a retry relationship from separate calls. Each runtime retains at most 256 pending snapshots and 256 completion markers, with oldest-first eviction and cleanup at settle, switch, shutdown and reload. Evicted calls can still report failures, but may lack timing or deduplication evidence. Disabled reporting does not retain diagnostic snapshots or inspect results.

Filter Sentry by `side:node`, `toolName`, `failureKind` and `errorCode`, then inspect the diagnostic context and the correlated breadcrumbs. Reproduce the recognized condition with a regression test; after publishing, compare events across releases and check whether the same condition still occurs. Configure urgent error alerts for `level:error`, excluding `environment:sentry-verification`. Retain warning issues for diagnosis and trends rather than urgent paging. Updating the alert rules is a Sentry administration step, independent of the code changes.

## Performance and reliability

The background launcher's local `launcher.log` records JSON lifecycle events: `launcher_ready`, `launcher_stop_requested`, `pi_force_stop`, and `pi_process_exit`. The default location is `~/.pi/agent/pi-web/launcher.log` (`%USERPROFILE%\.pi\agent\pi-web\launcher.log` on Windows); `PI_CODING_AGENT_DIR` overrides the agent directory. These records are local diagnostics, not Sentry events.

Each run has a separate random `instanceId`, UTC `timestamp`, process IDs, and monotonic `uptimeMs`. Readiness and exit include the listening port without the URL or access token. Exit records include `ready`, `exitCode`, `signal`, `forceStopRequested`, and a reason: `unexpected_exit`, `stop_request`, `restart_request`, `signal_sigterm`, `signal_sigint`, or `startup_failure`. Use the instance ID and timestamps to distinguish an unexpected Pi exit from a requested stop or upgrade; a stop request does not prove which cause ultimately terminated the process, so inspect the exit code and signal as well. The correlation ID is independent of the launcher control nonce. These lifecycle records omit arguments, paths, credentials, and arbitrary child output. If the launcher itself is forcibly terminated, it may not be able to record the child's exit.

After an accepted update, browser version polling retains temporary network failures as `request_failed` breadcrumbs while waiting for the restarted service. If the target version is still unavailable after 60 seconds, it stops polling and reports one `stage=update_restart`, `code=update_restart_timeout` error, even if a request is still pending. Closing settings cancels the pending request and deadline. HTTP and response parsing failures, and network failures from other requests, retain normal reporting.

Each side sends at most 20 events/minute and one event per fingerprint/minute. Repetition counts appear on the next retained event. Startup and transport queues are bounded to 20 events. Transport requests time out after 3 seconds, do not persist offline, and do not retry indefinitely. Rate-limited/dropped events are intentionally lossy. Browser configuration has a 1-second timeout and never gates rendering; SDKs load only when reporting is enabled. No tracing, profiling, automatic console/DOM instrumentation or token-by-token logging is enabled.

Request failures and asynchronous error events include additive `errorId`, `requestId`, `operationId`, `errorCode` and `errorReported` metadata. `errorReported` prevents the browser from bypassing server-side deduplication/rate limits. Protocol version 7 is retained. A `shutdown` event stops reconnection on normal exit; controlled launcher upgrades mark it with `reconnect: true` so the browser reconnects without reporting the expected interruption. A changed build ID replaces a retained bridge on `/web` after `/reload` so its static manifest matches the new assets.

## Private source maps and releases

`npm run build` produces matching browser/extension release IDs and debug IDs. It archives bundles/maps in `.sentry-artifacts/<buildId>/` and removes `.map` files from `web/dist` and `dist`. Archive directories are git-ignored and excluded from the npm package. These private files contain application source; store them as access-controlled CI artifacts. Ordinary local builds do not upload or contact Sentry.

For an upload-required release build, provide these **CI-only** variables:

```sh
export SENTRY_AUTH_TOKEN='YOUR_CI_TOKEN'
export SENTRY_ORG='YOUR_ORGANIZATION'
export SENTRY_PROJECT='YOUR_PROJECT'
npm run build:sentry
```

Use `SENTRY_BROWSER_PROJECT` / `SENTRY_NODE_PROJECT` for separate projects. The upload-required command fails on missing credentials or upload failure, and still removes maps from public output. Do not publish after a failed command. Auth tokens are never part of runtime configuration. The ordinary npm `prepack` rebuilds locally without uploading; use `npm pack --ignore-scripts` or `npm publish --ignore-scripts` only after checks and a successful `build:sentry` to package the exact uploaded artifacts.

### Required Actions configuration

The publishing workflow now fails closed until both credentials exist:

- Repository secret `SENTRY_AUTH_TOKEN`: source-map upload and release permissions.
- Repository secret `SENTRY_VERIFY_AUTH_TOKEN`: event/project read permission (`project:read` or equivalent).
- Optional repository variables `SENTRY_ORG` (default `soft`), `SENTRY_PROJECT` (default `pi-webapp`), `SENTRY_NODE_PROJECT`, `SENTRY_BROWSER_PROJECT`, and `SENTRY_URL` (default `https://us.sentry.io/`).
- Optional public DSN variables `PI_WEB_SENTRY_NODE_DSN` and `PI_WEB_SENTRY_BROWSER_DSN`. Both default to the built-in project; when using separate projects, configure each matching DSN as well.

Setting repository secrets requires an existing credential from the Sentry administrator. The code does not generate credentials or grant Sentry access. Do not put tokens in Actions variables or runtime configuration.

### Verify and publish the exact package

After the uploaded build, run:

```sh
mkdir -p .ci/release
npm pack --ignore-scripts --json --pack-destination .ci/release > .ci/release/pack.json
npm run verify:package -- --pack-manifest .ci/release/pack.json
# Requires SENTRY_VERIFY_AUTH_TOKEN, SENTRY_ORG and the destination project(s).
npm run verify:sentry -- --pack-manifest .ci/release/pack.json
node scripts/publish-verified-release.mjs
```

`verify:package` checks every packaged Node/browser asset against `.sentry-artifacts/<buildId>/`, confirms matching release literals and JS/map Debug IDs, rejects extra or missing assets, and checks that private maps are excluded. To inspect an older archive explicitly, pass `--archive PATH`. Both verification commands also accept `--tarball FILE`.

`verify:sentry` first checks credentials and the package, then invokes the packaged Node verification entry and serves the packaged browser assets on loopback with synthetic configuration. It sends only synthetic events to the configured Sentry DSNs with `environment=sentry-verification`; normal imports and normal browser environments do not run these probes. The Node entry requires `PI_WEB_SENTRY_VERIFY_RELEASE=true` and the verification environment; the browser requires a verification-configured server and the explicit `sentry_release_probe=1` URL flag. The CLI sets up these guards itself.

The verifier waits at most 120 seconds for the real events, checks release/build/side/Debug IDs, and requires original application frames to resolve to TypeScript. The synthetic exception must resolve to the exact source file and line recorded in the archived map. Browser maps give application sources stable `app:///web/src/` and `app:///shared/` paths before upload. Unmapped external SDK dependencies do not invalidate resolved application frames. A successful run writes `.ci/release/verified.json` with event IDs and the tarball SHA-256. The publisher verifies that receipt and hash before publishing that tarball with lifecycle scripts disabled. Missing credentials, failed uploads, mismatched package assets, unmapped application frames, missing receipts, or changed tarballs block publication. Version synchronization to main occurs only after these checks succeed.

For mapping failures, use Sentry's event source-map debugger or its `source-map-debug` API, and inspect matching Debug IDs for application bundles. Old tool-result events without original stacks remain limited even after source maps are uploaded.

## Verification and finding an error

Run `npm run check`, `npm run test`, `npm run build`, then `npm run test:browser`. Install test Chromium with `npx playwright install chromium`; on a machine with Chrome use `PI_WEB_TEST_CHROME=true npm run test:browser`. Browser tests intercept a synthetic Sentry destination and do not send to a real project. Optional performance comparison: `PI_WEB_TEST_CHROME=true PI_WEB_BENCHMARK=true npm run test:browser -- --grep 'streaming frame budget'`.

In Sentry, filter by `release`, `environment` and the `side` tag. Use `contexts.diagnostic.requestId` / `operationId` to follow a browser action into its asynchronous Agent result. Confirm a production-build exception has a `debug_meta` ID matching an uploaded map and resolves to original TypeScript.

The included tests verify default reporting through a mock transport, local delivery, correlation, privacy, bounded buffering, render fallback, reconnection and build debug IDs. Real ingestion must be checked in the configured Sentry project; Sentry-side source-map restoration additionally requires CI upload credentials. Context describes the failure path; it does not deterministically replay model responses, tool side effects or private content.
