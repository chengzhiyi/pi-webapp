export interface State {
  status: "idle" | "loading" | "ready" | "failed";
  url: string;
  canGoBack: boolean;
  canGoForward: boolean;
  error?: "address" | "navigation" | "load";
}

export type Action = "back" | "forward" | "reload" | "copy" | "external";
export type Bounds = { x: number; y: number; width: number; height: number };

export interface WebPreviewDesktop {
  open(id: string, url: string): Promise<State>;
  command(id: string, action: Action): Promise<State>;
  layout(id: string, bounds: Bounds | null): void;
  close(id: string): void;
  onState(cb: (id: string, state: State) => void): () => void;
}

declare global {
  interface Window { piWebPreview?: WebPreviewDesktop }
}

export function desktopWebPreview(): WebPreviewDesktop | undefined {
  const api = typeof window === "undefined" ? undefined : window.piWebPreview;
  if (api && typeof api.open === "function" && typeof api.command === "function" &&
    typeof api.layout === "function" && typeof api.close === "function" && typeof api.onState === "function") return api;
}
