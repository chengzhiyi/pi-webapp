import { installBrowserTelemetry, reportError } from "../../src/host/client/telemetry.ts";

installBrowserTelemetry();
void import("../../src/host/client/app.tsx").catch((cause) => reportError(cause, { stage: "startup" }));
