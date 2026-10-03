import { HttpError } from "./http-error.ts";
import { breadcrumb, ignoreError, reportError } from "./telemetry.ts";
import { isContentOperation, opaqueError, type ErrorCorrelation } from "../../shared/telemetry.ts";

export interface CorrelatedResponse { response: Response; correlation: ErrorCorrelation; route: string }

export async function bridgeFetch(path: string, options: RequestInit = {}, telemetry: { expectedNetworkFailure?: boolean } = {}): Promise<CorrelatedResponse> {
  const requestId = crypto.randomUUID();
  const route = path.split("?")[0]!;
  const operationId = route === "/api/message" ? crypto.randomUUID() : undefined;
  const headers = new Headers(options.headers);
  headers.set("X-Request-ID", requestId);
  if (operationId) headers.set("X-Operation-ID", operationId);
  const correlation: ErrorCorrelation = { requestId, operationId };
  const started = performance.now();
  breadcrumb("request_start", { ...correlation, route, method: options.method ?? "GET" });
  try {
    const response = await fetch(path, { ...options, headers });
    correlation.requestId = response.headers.get("X-Request-ID") || requestId;
    correlation.operationId = response.headers.get("X-Operation-ID") || operationId;
    breadcrumb("request_end", { ...correlation, route, status: response.status, durationMs: Math.round(performance.now() - started) });
    return { response, correlation, route };
  } catch (cause) {
    const context = { ...correlation, route, stage: "network", durationMs: Math.round(performance.now() - started) };
    breadcrumb("request_failed", context);
    if (!telemetry.expectedNetworkFailure) reportError(cause, context);
    throw cause;
  }
}

export async function bridgeJson(result: CorrelatedResponse): Promise<any> {
  const { response, correlation, route } = result;
  let body: any;
  try { body = await response.json(); }
  catch (cause) { reportError(cause, { ...correlation, route, status: response.status, stage: "response_parse" }); throw cause; }
  if (!response.ok) {
    const error = new HttpError(typeof body?.error === "string" ? body.error : `Request failed: ${response.status}`, response.status);
    const serverCaptured = typeof body?.errorId === "string" && /^[a-f0-9]{32}$/.test(body.errorId);
    const expected = body?.errorCode === "validation_error" || (response.status < 500 && body?.errorCode !== "unexpected_error");
    if (serverCaptured || body?.errorReported === true || expected) ignoreError(error);
    else {
      reportError(isContentOperation(route) ? opaqueError(error, "Agent or provider operation failed") : error, { ...correlation, route, status: response.status, stage: "http" });
      ignoreError(error);
    }
    throw error;
  }
  return body;
}
