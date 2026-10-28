import { randomUUID } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
import { EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';

const optionsFor = env => ({ httpProxy: env.http_proxy ?? env.HTTP_PROXY ?? env.all_proxy ?? env.ALL_PROXY ?? '', httpsProxy: env.https_proxy ?? env.HTTPS_PROXY ?? env.all_proxy ?? env.ALL_PROXY ?? '', noProxy: env.no_proxy ?? env.NO_PROXY ?? '' });
function proxyRoute(env, input) {
  const options = optionsFor(env); let url;
  try { url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url); } catch { return false; }
  if (!(url.protocol === 'https:' ? options.httpsProxy || options.httpProxy : options.httpProxy)) return false;
  const noProxy = options.noProxy.toLowerCase(); if (noProxy === '*') return false;
  const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80), host = url.hostname.toLowerCase();
  return !noProxy.split(/[,\s]/).filter(Boolean).some(entry => {
    const match = entry.match(/^(.+):(\d+)$/), domain = (match?.[1] ?? entry).replace(/^\*?\./, '');
    return (!match || Number(match[2]) === port) && (host === domain || host.endsWith('.' + domain));
  });
}
function environmentDispatcher(env) {
  const options = optionsFor(env);
  for (const value of [options.httpProxy, options.httpsProxy].filter(Boolean)) {
    try { if (!['http:', 'https:'].includes(new URL(value).protocol)) throw new Error(); }
    catch { throw Object.assign(new Error('HTTP proxy configuration is invalid or unsupported'), { code: 'PROXY_CONFIGURATION_INVALID' }); }
  }
  return new EnvHttpProxyAgent(options);
}
/** A neutral transport seam shared by registry downloads and model adapters.
 * autoClose gives EACH request its own lease, released on body completion,
 * cancellation or failure. Reusing this fetch never reuses an already closed
 * dispatcher. Explicit custom fetches retain ownership of their transport. */
export function createEnvironmentFetch({ env = process.env, onFailure = () => {}, fetchRequest = globalThis.fetch, autoClose = false } = {}) {
  let shared; const leases = new Set(), managed = fetchRequest === globalThis.fetch;
  const emit = (error, context) => { try { onFailure(error, context); } catch { /* Diagnostics cannot break transport. */ } };
  const release = dispatcher => {
    if (!dispatcher) return Promise.resolve();
    return dispatcher.close().finally(() => leases.delete(dispatcher));
  };
  const fetch = async (input, init) => {
    const context = { requestId: randomUUID(), phase: 'headers', proxied: managed && proxyRoute(env, input) };
    let dispatcher = autoClose ? undefined : shared, settled = false;
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const aborted = () => settle();
    const settle = () => {
      signal?.removeEventListener('abort', aborted);
      if (!settled && autoClose) { settled = true; void release(dispatcher).catch(() => {}); }
    };
    let response;
    try {
      if (managed) {
        dispatcher ??= environmentDispatcher(env); leases.add(dispatcher); if (!autoClose) shared = dispatcher;
        response = await fetchRequest(input, { ...init, dispatcher });
      } else response = await fetchRequest(input, init);
    } catch (error) { emit(error, context); settle(); throw error; }
    if (!response.ok) emit(undefined, { ...context, status: response.status });
    if (!response.body) { settle(); return response; }
    const reader = response.body.getReader();
    // Abort owns lease cleanup even when the consumer has paused body reads.
    // Native fetch keeps its original AbortError semantics; we do not substitute
    // a clean EOF or manufacture a successful partial download.
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) settle();
    const body = new ReadableStream({
      async pull(controller) {
        try {
          const item = await reader.read();
          if (item.done) { controller.close(); reader.releaseLock(); settle(); } else controller.enqueue(item.value);
        } catch (error) {
          emit(error, { ...context, phase: 'body' }); controller.error(error); reader.releaseLock(); settle();
        }
      },
      async cancel(reason) { try { await reader.cancel(reason); } finally { reader.releaseLock(); settle(); } },
    });
    const wrapped = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    Object.defineProperties(wrapped, { url: { value: response.url }, redirected: { value: response.redirected }, type: { value: response.type } });
    return wrapped;
  };
  return { fetch, close: async () => { await Promise.all([...leases].map(release)); } };
}
/** Production one-shot requests: no installer lifetime/close protocol and no
 * process-global mutation. The response body owns the transport lease. */
export const environmentFetch = (input, init) => createEnvironmentFetch({ autoClose: true }).fetch(input, init);

/** Opt-in process scope for an owned launcher child only. Callers decide how to
 * report failures; this transport knows nothing about models or plugins. */
export function configureEnvironmentProxy({ env = process.env, onFailure = () => {} } = {}) {
  const previous = getGlobalDispatcher(); let dispatcher;
  try { dispatcher = environmentDispatcher(env); }
  catch (error) { onFailure(error, { requestId: randomUUID(), phase: 'headers', proxied: true }); return async () => {}; }
  setGlobalDispatcher(dispatcher);
  const errors = channel('undici:request:error');
  const receive = ({ error, request }) => { try { onFailure(error, { requestId: randomUUID(), phase: 'headers', proxied: proxyRoute(env, request?.origin) }); } catch {} };
  errors.subscribe(receive);
  return async () => { errors.unsubscribe(receive); if (getGlobalDispatcher() === dispatcher) setGlobalDispatcher(previous); await dispatcher.close(); };
}
