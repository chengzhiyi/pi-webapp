// The only Sentry APIs the Node host uses. scripts/build.mjs bundles these into dist/extension.js,
// so installs do not pull @sentry/node's install closure (CLI, bundler plugins, server utils).
export { NodeClient, defaultStackParser } from "@sentry/node";
export { createTransport, linkedErrorsIntegration, Scope } from "@sentry/core";
