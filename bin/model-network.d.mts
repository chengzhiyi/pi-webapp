export interface ModelNetworkDiagnostic {
  errorId: string; requestId: string; operationId?: string;
  stage: 'model_headers' | 'model_stream' | 'model_admission' | 'http_transport';
  kind: 'lifecycle' | 'tls' | 'proxy' | 'timeout' | 'dns' | 'server' | 'http' | 'interrupted' | 'cancelled' | 'network';
  status?: number; proxied: boolean; causes: Array<{ name: string; code?: string }>;
}
export function modelNetworkDiagnostic(error: unknown, context?: { stage?: string; requestId?: string; operationId?: string; status?: number; proxied?: boolean }): ModelNetworkDiagnostic;
export function createModelFetch(options?: { env?: Record<string,string | undefined>; onDiagnostic?: (diagnostic: ModelNetworkDiagnostic) => void; fetchRequest?: typeof globalThis.fetch }): { fetch: typeof globalThis.fetch; close(): Promise<void> };
export function configureOwnedProcessNetworking(options?: { env?: Record<string,string | undefined>; onDiagnostic?: (diagnostic: ModelNetworkDiagnostic) => void }): () => Promise<void>;
