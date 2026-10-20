import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { accessToken } from "../../../../host/client/access-token.ts";
import { bridgeFetch, bridgeJson } from "../../../../host/client/telemetry-fetch.ts";
import { HttpError } from "../../../../host/client/http-error.ts";
import type { TerminalFrame } from "../contract/terminal.ts";

export interface TerminalState { phase: "starting" | "connected" | "disconnected" | "failed" | "exited"; exitCode?: number }

/** xterm creates its renderer and scrollbar styles synchronously during open(). */
function openTerminal(terminal: Terminal, container: HTMLElement) {
  const nonce = document.querySelector<HTMLMetaElement>('meta[name="pi-style-nonce"]')?.content;
  const create = document.createElement;
  // Limit nonce assignment to this synchronous library call; restore even if it throws.
  document.createElement = function(tag: string, options?: ElementCreationOptions) {
    const element = create.call(document, tag, options);
    if (nonce && element instanceof HTMLStyleElement) element.nonce = nonce;
    return element;
  } as typeof create;
  try { terminal.open(container); } finally { document.createElement = create; }
}

/** Owned by a Dock tab, never by the lifetime of a rendered pane or active session. */
export class TerminalSession {
  readonly element = document.createElement("div");
  readonly terminal = new Terminal({ cursorBlink: true, scrollback: 2000, fontSize: 13, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", minimumContrastRatio: 4.5 });
  readonly fit = new FitAddon();
  private state: TerminalState = { phase: "starting" };
  private readonly listeners = new Set<() => void>();
  private lifetime: AbortController | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private opened = false;
  private created = false;
  private disposed = false;
  private commands = Promise.resolve();
  private queued = 0;
  private active = true;
  private creation: Promise<unknown> | undefined;
  private offline = () => {
    if (this.state.phase === "exited" || this.state.phase === "failed") return;
    this.lifetime?.abort();
    this.patch({ phase: "disconnected" });
  };
  private online = () => { void this.connect(); };
  readonly id: string;
  readonly sessionId: string;
  constructor(id: string, sessionId: string) {
    this.id = id; this.sessionId = sessionId;
    this.element.style.cssText = "width:100%;height:100%;min-width:0;overflow:hidden";
    this.terminal.loadAddon(this.fit);
    window.addEventListener("offline", this.offline);
    window.addEventListener("online", this.online);
    this.terminal.onData(data => this.input(data));
    this.terminal.onResize(size => {
      if (this.state.phase === "connected" && this.active) this.enqueue("resize", size);
    });
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.state;
  private patch(state: TerminalState) { this.state = state; this.terminal.options.disableStdin = state.phase !== "connected" || !this.active; for (const listener of this.listeners) listener(); }
  activate(active: boolean) {
    this.active = active;
    this.terminal.options.disableStdin = !active || this.state.phase !== "connected";
    if (active && this.opened && !this.lifetime && this.state.phase === "disconnected") void this.connect();
  }
  mount(container: HTMLElement) {
    container.append(this.element);
    if (!this.opened) {
      this.opened = true;
      openTerminal(this.terminal, this.element);
      this.terminal.textarea?.setAttribute("aria-label", "Terminal input");
      void this.connect();
    }
  }
  measure() {
    if (!this.element.isConnected || !this.element.clientWidth || !this.element.clientHeight || this.element.closest("[aria-hidden=true]")) return;
    const dark = document.body.hasAttribute("data-ds-dark-theme");
    this.terminal.options.theme = dark ? { background: "#151618", foreground: "#e5e5e5", cursor: "#e5e5e5" } : { background: "#ffffff", foreground: "#242424", cursor: "#242424" };
    const proposed = this.fit.proposeDimensions();
    if (proposed) this.terminal.resize(Math.min(500, Math.max(2, proposed.cols)), Math.min(300, Math.max(1, proposed.rows)));
  }
  private async request(action: string, body: object, signal?: AbortSignal) {
    return bridgeFetch(`/api/terminal/${action}`, { method: "POST", headers: { Authorization: `Bearer ${accessToken()}`, "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: this.sessionId, id: this.id, ...body }), signal }, { expectedNetworkFailure: true });
  }
  async connect() {
    if (this.disposed || this.lifetime || !this.active || !navigator.onLine || this.state.phase === "exited") return;
    clearTimeout(this.retry);
    const lifetime = new AbortController(); this.lifetime = lifetime;
    this.patch({ phase: this.created ? "disconnected" : "starting" });
    try {
      if (!this.created) {
        // Keep creation alive across a tab close, then explicitly reap its result.
        this.creation = this.request("create", { cols: this.terminal.cols, rows: this.terminal.rows }).then(bridgeJson);
        await this.creation; this.created = true;
      }
      if (this.disposed) return;
      const result = await this.request("attach", {}, lifetime.signal);
      if (!result.response.ok) await bridgeJson(result);
      const reader = result.response.body!.getReader();
      try {
        const decoder = new TextDecoder(); let pending = "";
        while (!this.disposed) {
          const { done, value } = await reader.read();
          if (done) break;
          pending += decoder.decode(value, { stream: true });
          if (pending.length > 2 * 1024 * 1024) throw new Error("Terminal stream overflow");
          let index: number;
          while ((index = pending.indexOf("\n")) >= 0) {
            const frame = JSON.parse(pending.slice(0, index)) as TerminalFrame; pending = pending.slice(index + 1);
            if (frame.type === "snapshot") {
              this.terminal.reset(); this.terminal.resize(frame.cols, frame.rows);
              await new Promise<void>(resolve => this.terminal.write(frame.screen, resolve));
              this.patch({ phase: "connected" }); this.measure();
              if (this.active) this.enqueue("resize", { cols: this.terminal.cols, rows: this.terminal.rows });
            } else if (frame.type === "output") await new Promise<void>(resolve => this.terminal.write(frame.data, resolve));
            // Local fit owns the live grid. A server echo may lag a newer window measurement.
            else if (frame.type === "resize") continue;
            else if (frame.type === "exit") { this.patch({ phase: "exited", exitCode: frame.exitCode }); return; }
          }
        }
        throw new Error("Terminal disconnected");
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    } catch (error) {
      if (this.disposed) return;
      const fatal = error instanceof HttpError && error.status !== 409 && error.status < 500;
      this.patch({ phase: fatal ? "failed" : "disconnected" });
      if (!fatal) this.retry = setTimeout(() => { void this.connect(); }, 1500);
    } finally { if (this.lifetime === lifetime) this.lifetime = undefined; }
  }
  private input(data: string) {
    if (this.state.phase !== "connected" || !this.active) return;
    // Bound paste payloads and pending input. Never replay uncertain input after a disconnect.
    if (this.queued + data.length > 64 * 1024) { this.lifetime?.abort(); return; }
    let chunk = "";
    for (const char of data) { chunk += char; if (chunk.length >= 4000) { this.enqueue("input", { data: chunk }); chunk = ""; } }
    if (chunk) this.enqueue("input", { data: chunk });
  }
  private enqueue(action: "input" | "resize", value: { data?: string; cols?: number; rows?: number }) {
    const lifetime = this.lifetime;
    const size = value.data?.length ?? 0; this.queued += size;
    this.commands = this.commands.then(async () => {
      if (this.disposed || !this.active || this.state.phase !== "connected" || lifetime !== this.lifetime || lifetime?.signal.aborted) return;
      await bridgeJson(await this.request(action, value, lifetime?.signal));
    }).catch(error => {
      // A session switch can reject a request already in flight; keep its output follower alive.
      if (!(error instanceof HttpError && error.status === 409)) lifetime?.abort();
    }).finally(() => { this.queued -= size; });
  }
  dispose() {
    this.disposed = true; clearTimeout(this.retry); this.lifetime?.abort();
    window.removeEventListener("offline", this.offline);
    window.removeEventListener("online", this.online);
    void (async () => {
      try { await this.creation; if (this.created) await bridgeJson(await this.request("close", {})); } catch { /* Server retention reaps an unreachable shell. */ }
      this.terminal.dispose(); this.element.remove(); this.listeners.clear();
    })();
  }
}
