export interface HttpFailureContext { requestId: string; phase: 'headers' | 'body'; proxied: boolean; status?: number }
export interface EnvironmentFetchOptions { env?: Record<string,string | undefined>; onFailure?: (error: unknown, context: HttpFailureContext) => void; fetchRequest?: typeof globalThis.fetch; autoClose?: boolean }
export function createEnvironmentFetch(options?: EnvironmentFetchOptions): { fetch: typeof globalThis.fetch; close(): Promise<void> };
export const environmentFetch: typeof globalThis.fetch;
export function configureEnvironmentProxy(options?: Pick<EnvironmentFetchOptions,'env' | 'onFailure'>): () => Promise<void>;
