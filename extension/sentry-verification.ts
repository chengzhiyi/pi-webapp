import { NodeTelemetry } from "./telemetry.ts";
import { release, buildId } from "../shared/build-info.ts";

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
