import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { DiagnosticFields, ErrorCorrelation } from '../../../contracts/telemetry.ts';
import { createModelFetch, modelNetworkDiagnostic, type ModelNetworkDiagnostic } from '../../../../bin/model-network.mjs';

/** These SDK adapters publicly accept ProviderRequestOptions.fetch. Google and
 * Bedrock intentionally keep their SDK-native transports instead of receiving an
 * unsupported override. No global fetch replacement or provider credentials. */
function providerEnvironment(overrides?: Record<string, string>): Record<string, string | undefined> {
  const env = { ...process.env, ...overrides };
  for (const lower of ["http_proxy", "https_proxy", "all_proxy", "no_proxy"]) {
    // An explicit provider-scoped uppercase value wins over an inherited lower
    // case alias, and an explicit empty value really disables that setting.
    if (overrides && lower.toUpperCase() in overrides && !(lower in overrides)) delete env[lower];
  }
  return env;
}
const injectable = new Set(['openai-codex-responses', 'openai-responses', 'azure-openai-responses', 'openai-completions', 'anthropic-messages', 'mistral-conversations', 'pi-messages']);
export function installModelTransport(session: AgentSession, onDiagnostic: (diagnostic: ModelNetworkDiagnostic) => void, operationId: () => string | undefined = () => undefined): void {
  const stream = session.agent.streamFunction;
  session.agent.streamFunction = async (model, context, options) => {
    if (!injectable.has(model.api)) return stream(model, context, options);
    const id = operationId();
    const transport = createModelFetch({ env: providerEnvironment(options?.env), ...(options?.fetch ? { fetchRequest: options.fetch } : {}), onDiagnostic: diagnostic => {
      const detail = { ...diagnostic, ...(id ? { operationId: id } : {}) };
      console.error(JSON.stringify({ event: 'model_transport_failure', ...detail }));
      onDiagnostic(detail);
    } });
    try {
      const result = await stream(model, context, { ...options, fetch: transport.fetch });
      // The event stream's final result owns the HTTP body lifetime. Starting a
      // request is not permission to close its proxy connections while streaming.
      void result.result().finally(() => transport.close()).catch(() => {});
      return result;
    } catch (error) { await transport.close(); throw error; }
  };
}

/** Admission failures occur before a model HTTP request exists. Keep their
 * diagnostic stage and correlation distinct; preserve the original rejection. */
export function assertModelAdmission(admit: () => void, correlation?: ErrorCorrelation, report?: (error: Error, fields: DiagnosticFields) => unknown): void {
  try { admit(); }
  catch (error) {
    const detail = modelNetworkDiagnostic(error, { ...correlation, stage: "model_admission" });
    try {
      console.error(JSON.stringify({ event: "model_admission_blocked", ...detail }));
      report?.(new Error("Model admission blocked before any HTTP request"), { ...correlation, errorId: detail.errorId, requestId: detail.requestId,
        stage: detail.stage, code: "hosted_admission_blocked", networkKind: detail.kind, networkStage: detail.stage,
        causeCodes: detail.causes.flatMap(cause => cause.code ? [cause.code] : []).join(",") });
    } catch { /* Diagnostic failure cannot replace the original admission error. */ }
    throw error;
  }
}
