import { randomUUID } from 'node:crypto';
import { createEnvironmentFetch, configureEnvironmentProxy } from './http-transport.mjs';

const errorNames = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'AbortError', 'TimeoutError', 'AggregateError', 'ConnectTimeoutError', 'HeadersTimeoutError', 'BodyTimeoutError', 'SocketError', 'RequestAbortedError', 'InvalidArgumentError', 'ResponseStatusCodeError', 'DOMException']);
const allowedCode = value => typeof value === 'string' && /^(?:E[A-Z0-9_]{1,40}|UND_ERR_[A-Z0-9_]{1,50}|CERT_[A-Z0-9_]{1,40}|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_[A-Z0-9_]{1,40}|PROXY_[A-Z_]{1,40}|ABORT_ERR|agent_settlement_timeout|sdk_capability_missing|hosted_admission_blocked)$/.test(value) ? value : undefined;
/** Rebuild diagnostic fields, never copy native messages (which may contain
 * signed URLs, proxy passwords, request bodies, provider output or user paths). */
export function modelNetworkDiagnostic(error, context = {}) {
  const causes = []; const seen = new Set();
  const visit = (cause, depth = 0) => {
    if (!cause || depth > 4 || seen.has(cause) || causes.length >= 8) return;
    seen.add(cause);
    const code = allowedCode(cause.code);
    causes.push({ name: errorNames.has(cause.name) ? cause.name : 'Error', ...(code ? { code } : {}) });
    visit(cause.cause, depth + 1);
    if (cause instanceof AggregateError) for (const child of cause.errors.slice(0, 4)) visit(child, depth + 1);
  };
  visit(error);
  const codes = causes.flatMap(item => item.code ? [item.code] : []);
  const kind = context.stage === 'model_admission' || codes.some(code => ['agent_settlement_timeout', 'sdk_capability_missing', 'hosted_admission_blocked'].includes(code)) ? 'lifecycle'
    : codes.some(code => /CERT|TLS|SSL/.test(code)) ? 'tls'
    : codes.some(code => /^PROXY_/.test(code)) || context.proxied && codes.some(code => /ECONNREFUSED|ENOTFOUND|EAI_AGAIN/.test(code)) ? 'proxy'
    : codes.some(code => /TIMEOUT|ETIMEDOUT/.test(code)) || causes.some(item => /TimeoutError$/.test(item.name)) ? 'timeout'
    : causes.some(item => item.name === 'AbortError' || item.code === 'ABORT_ERR' || item.code === 'UND_ERR_ABORTED') ? 'cancelled'
    : codes.some(code => /ENOTFOUND|EAI_AGAIN/.test(code)) ? 'dns'
    : context.status >= 500 ? 'server'
    : context.status >= 400 ? 'http'
    : context.stage === 'model_stream' ? 'interrupted'
    : 'network';
  const id = value => typeof value === 'string' && /^[\w-]{1,80}$/.test(value) ? value : undefined;
  return { errorId: randomUUID(), requestId: id(context.requestId) ?? randomUUID(), ...(id(context.operationId) ? { operationId: context.operationId } : {}),
    stage: ['model_headers', 'model_stream', 'model_admission', 'http_transport'].includes(context.stage) ? context.stage : 'model_headers', kind,
    ...(Number.isInteger(context.status) ? { status: context.status } : {}), proxied: context.proxied === true, causes };
}
/** Model-specific diagnosis decorates the generic HTTP transport. Registry
 * download code never imports or depends on model telemetry. */
export function createModelFetch({ env = process.env, onDiagnostic = () => {}, fetchRequest = globalThis.fetch } = {}) {
  return createEnvironmentFetch({ env, fetchRequest, onFailure: (error, context) => onDiagnostic(modelNetworkDiagnostic(error, {
    ...context, stage: context.phase === 'body' ? 'model_stream' : 'model_headers',
  })) });
}
/** Owned launcher process only. An extension must not change a parent TUI's
 * global dispatcher; independently created web sessions use createModelFetch. */
export function configureOwnedProcessNetworking({ env = process.env, onDiagnostic = diagnostic => console.error(JSON.stringify({ event: 'http_transport_failure', ...diagnostic })) } = {}) {
  return configureEnvironmentProxy({ env, onFailure: (error, context) => onDiagnostic(modelNetworkDiagnostic(error, { ...context, stage: 'http_transport' })) });
}
