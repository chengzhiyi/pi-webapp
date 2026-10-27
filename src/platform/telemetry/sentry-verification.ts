import { NodeTelemetry, readTelemetryConfig } from "./telemetry.ts";
import { release, buildId } from "../../contracts/build-info.ts";

/** Verify the shipped default, independently of inherited CI/user environment. */
export async function verifySentryDisabledRelease() {
  for (const env of [{}, { PI_WEB_SENTRY_DSN: "https://public@example.com/1" }, { PI_WEB_SENTRY_ENABLED: "false" }]) {
    const config = readTelemetryConfig(env);
    const telemetry = new NodeTelemetry({ env, monitor: false, transport: () => { throw new Error("Disabled telemetry loaded a transport"); } });
    try {
      await telemetry.ready;
      if (config.node.enabled || config.browser.enabled || telemetry.enabled || telemetry.reporter || telemetry.capture(new Error("Disabled release probe")) || await telemetry.flush()) throw new Error("Packaged Sentry is not disabled by default");
    } finally { await telemetry.close(); }
  }
  return { release, buildId, browser: readTelemetryConfig({}).browser };
}

/** Explicit release-test entry; importing the extension never executes a probe. */
export async function verifySentryNodeRelease(): Promise<{ eventId: string; release: string; buildId: string }> {
  if (process.env.PI_WEB_SENTRY_VERIFY_RELEASE !== "true" || process.env.PI_WEB_SENTRY_ENVIRONMENT !== "sentry-verification") throw new Error("Sentry release verification is not enabled");
  const telemetry = new NodeTelemetry({ monitor: false });
  try {
    await telemetry.ready;
    if (!telemetry.enabled) throw new Error("Sentry verification transport is disabled");
    const eventId = telemetry.capture(new Error("Sentry Node release verification"), { stage: "release_verification", code: "sentry_release_probe" });
    if (!eventId || !await telemetry.flush(3000)) throw new Error("Sentry verification event was not delivered");
    return { eventId, release, buildId };
  } finally { await telemetry.close(); }
}
