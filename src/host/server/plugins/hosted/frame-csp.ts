/** CSP for hosted plugin documents, workers and subresources. The parent page CSP is separate and unchanged. */
export const HOSTED_FRAME_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; font-src 'self' data:; connect-src 'self'; img-src 'self' data: blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'";
/** Capability string a package must declare (with manifest `browser.wasm: true`) to ask for WebAssembly compilation. */
export const BROWSER_WASM_CAPABILITY = "browser.wasm";
/**
 * Adds only `'wasm-unsafe-eval'` (never `'unsafe-eval'`): WebAssembly compilation, not JS eval.
 * Granted when the reviewed host policy AND the package manifest both ask for it.
 */
export function hostedFrameCsp(options: { wasm?: boolean } = {}): string {
  return options.wasm ? HOSTED_FRAME_CSP.replace("script-src 'self'", "script-src 'self' 'wasm-unsafe-eval'") : HOSTED_FRAME_CSP;
}
export function manifestRequestsWasm(manifest: unknown): boolean {
  const m = manifest as { browser?: { wasm?: unknown }; capabilities?: unknown } | null;
  return !!m && m.browser?.wasm === true && Array.isArray(m.capabilities) && m.capabilities.includes(BROWSER_WASM_CAPABILITY);
}
