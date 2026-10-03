import { BrowserClient, defaultStackParser, Scope, linkedErrorsIntegration, createTransport } from "@sentry/react";
import { ErrorReporter, privateBeforeSend, boundedFetchTransport, privateDataCollection, type TelemetryConfig } from "../../shared/telemetry.ts";

/** A separate lazy entry keeps unrelated SDK integrations out of the error-only bundle. */
export function createBrowserReporter(config: TelemetryConfig): ErrorReporter {
  const client = new BrowserClient({
    ...config, dist: config.buildId, integrations: [], stackParser: defaultStackParser,
    transport: (options) => boundedFetchTransport(createTransport, options), beforeSend: privateBeforeSend, sendClientReports: false,
    dataCollection: { ...privateDataCollection, httpBodies: [] }, beforeSendLog: () => null, beforeSendMetric: () => null,
  });
  client.init();
  return new ErrorReporter(client, "browser", config.buildId, { Scope, linkedErrorsIntegration });
}
