import assert from "node:assert/strict";
import test from "node:test";
// @ts-ignore Build-only JavaScript helper.
import { verifyReleaseReceipt } from "../scripts/release-receipt.mjs";
import { verifySentryDisabledRelease } from "../src/platform/telemetry/sentry-verification.ts";

const filename = "pi-webapp-0.1.31.tgz";
const digest = "a".repeat(64);
const disabled = { filename, sha256: digest, telemetryMode: "disabled-by-default", nodeDisabled: true, browserDisabled: true };

test("disabled release entry verifies defaults even if CI inherited an enabling flag", async () => {
  const previous = process.env.PI_WEB_SENTRY_ENABLED;
  process.env.PI_WEB_SENTRY_ENABLED = "true";
  try { assert.equal((await verifySentryDisabledRelease()).browser.enabled, false); }
  finally { if (previous === undefined) delete process.env.PI_WEB_SENTRY_ENABLED; else process.env.PI_WEB_SENTRY_ENABLED = previous; }
});

test("disabled receipt is explicit, hash-bound and contains no fabricated event IDs", () => {
  assert.doesNotThrow(() => verifyReleaseReceipt(disabled, filename, digest));
  for (const change of [{ filename: "other.tgz" }, { sha256: "b".repeat(64) }, { nodeDisabled: false }, { browserDisabled: undefined }, { telemetryMode: undefined }, { telemetryMode: "skip" }, { nodeEventId: "1".repeat(32) }, { browserEventId: "2".repeat(32) }]) {
    assert.throws(() => verifyReleaseReceipt({ ...disabled, ...change }, filename, digest));
  }
});

test("live receipt still requires two real-format event IDs; it cannot masquerade as disabled", () => {
  const live = { filename, sha256: digest, telemetryMode: "sentry-live", nodeEventId: "1".repeat(32), browserEventId: "2".repeat(32) };
  assert.doesNotThrow(() => verifyReleaseReceipt(live, filename, digest));
  assert.throws(() => verifyReleaseReceipt({ ...live, browserEventId: undefined }, filename, digest));
  assert.throws(() => verifyReleaseReceipt({ ...disabled, telemetryMode: "sentry-live" }, filename, digest));
});
