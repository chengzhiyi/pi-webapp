import { installBrowserTelemetry, reportError } from "./telemetry.ts";

installBrowserTelemetry();
void import("./app.tsx").catch((cause) => reportError(cause, { stage: "startup" }));
