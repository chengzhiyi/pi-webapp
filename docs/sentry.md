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

User cancellation, stopping an Agent, normal shutdown, known validation failures and stale-session conflicts are excluded. No conversation, source contents, attachments, login values, request/response bodies, console output or DOM recordings are deliberately collected. Agent/provider error messages are replaced with generic diagnostic labels. Other exception text is scrubbed for credentials, URLs, quoted values, email addresses and absolute paths. Arbitrary free-form exception messages cannot be classified perfectly; do not put private data in exceptions.

Browser events go directly to the configured Sentry host with no Pi authorization header, cookies or referrer. The authenticated configuration endpoint returns only the public DSN and build metadata. Node reporting uses a private client and explicit scopes without initializing a global SDK or changing Pi's uncaught-error/async-context handling; inherited SDK attachments are discarded before sending.

## Performance and reliability

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

## Verification and finding an error

Run `npm run check`, `npm run test`, `npm run build`, then `npm run test:browser`. Install test Chromium with `npx playwright install chromium`; on a machine with Chrome use `PI_WEB_TEST_CHROME=true npm run test:browser`. Browser tests intercept a synthetic Sentry destination and do not send to a real project. Optional performance comparison: `PI_WEB_TEST_CHROME=true PI_WEB_BENCHMARK=true npm run test:browser -- --grep 'streaming frame budget'`.

In Sentry, filter by `release`, `environment` and the `side` tag. Use `contexts.diagnostic.requestId` / `operationId` to follow a browser action into its asynchronous Agent result. Confirm a production-build exception has a `debug_meta` ID matching an uploaded map and resolves to original TypeScript.

The included tests verify default reporting through a mock transport, local delivery, correlation, privacy, bounded buffering, render fallback, reconnection and build debug IDs. Real ingestion must be checked in the configured Sentry project; Sentry-side source-map restoration additionally requires CI upload credentials. Context describes the failure path; it does not deterministically replay model responses, tool side effects or private content.
