import { randomBytes } from "node:crypto";
import type { AuthEvent, AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";

export type LoginMethod = "api_key" | "oauth";

/** The web button already chooses browser sign-in, so skip Pi's redundant method picker. */
export function preferBrowserLogin(providerId: string, method: LoginMethod, interaction: AuthInteraction): AuthInteraction {
  if (providerId !== "openai-codex" || method !== "oauth") return interaction;
  return {
    ...interaction,
    prompt: (prompt) => prompt.type === "select"
      && prompt.options.some((option) => option.id === "browser")
      && prompt.options.some((option) => option.id === "device_code")
      ? Promise.resolve("browser")
      : interaction.prompt(prompt),
  };
}
export interface ProviderView { id: string; name: string; configured: boolean; storedCredential: boolean; methods: LoginMethod[] }
export type LoginPrompt = AuthPrompt extends infer T ? T extends unknown ? Omit<T, "signal"> : never : never;
export interface LoginView {
  id: string;
  providerId: string;
  method: LoginMethod;
  status: "running" | "waiting" | "done" | "error" | "cancelled";
  prompt?: LoginPrompt;
  event?: AuthEvent;
  authorization?: Extract<AuthEvent, { type: "auth_url" | "device_code" }>;
  error?: string;
}

interface Flow {
  view: LoginView;
  controller: AbortController;
  answer?: (value: string) => void;
  reject?: (reason: Error) => void;
}

/** A single local browser login at a time. Secrets only pass through prompt promises. */
export class ProviderLoginController {
  private readonly flows = new Map<string, Flow>();

  start(providerId: string, method: LoginMethod, login: (providerId: string, method: LoginMethod, interaction: AuthInteraction) => Promise<void>, initialSecret?: string): LoginView {
    const active = this.getActive();
    if (active) {
      if (active.providerId === providerId && active.method === method && initialSecret === undefined) return active;
      throw new Error("其他提供方的登录正在进行，请先完成或取消当前登录");
    }
    this.flows.clear();
    const id = randomBytes(18).toString("base64url");
    const flow: Flow = { view: { id, providerId, method, status: "running" }, controller: new AbortController() };
    this.flows.set(id, flow);
    void login(providerId, method, {
      signal: flow.controller.signal,
      notify: (event) => {
        flow.view = { ...flow.view, event, ...(event.type === "auth_url" || event.type === "device_code" ? { authorization: event } : {}) };
      },
      prompt: (prompt) => {
        if (prompt.type === "secret" && initialSecret !== undefined) {
          const answer = initialSecret;
          initialSecret = undefined;
          return Promise.resolve(answer);
        }
        return new Promise<string>((resolve, reject) => {
        const { signal, ...publicPrompt } = prompt;
        flow.answer = resolve;
        flow.reject = reject;
        flow.view = { ...flow.view, status: "waiting", prompt: publicPrompt };
        if (signal?.aborted) reject(new Error("登录输入已取消"));
        else signal?.addEventListener("abort", () => reject(new Error("登录输入已取消")), { once: true });
        });
      },
    }).then(() => {
      if (flow.view.status !== "cancelled") flow.view = { id, providerId, method, status: "done" };
    }).catch(() => {
      if (flow.view.status !== "cancelled") flow.view = { id, providerId, method, status: "error", error: "登录失败，请检查提供方提示并重试。" };
    });
    return { ...flow.view };
  }

  get(id: string): LoginView | undefined {
    const view = this.flows.get(id)?.view;
    return view ? { ...view } : undefined;
  }

  getActive(): LoginView | undefined {
    const view = [...this.flows.values()].find(({ view }) => view.status === "running" || view.status === "waiting")?.view;
    return view ? { ...view } : undefined;
  }

  respond(id: string, value: string): boolean {
    const flow = this.flows.get(id);
    if (!flow?.answer || flow.view.status !== "waiting") return false;
    if (flow.view.prompt?.type === "select" && !flow.view.prompt.options.some((option) => option.id === value)) return false;
    const answer = flow.answer;
    flow.answer = undefined;
    flow.reject = undefined;
    flow.view = { ...flow.view, status: "running", prompt: undefined };
    answer(value);
    return true;
  }

  cancel(id: string): boolean {
    const flow = this.flows.get(id);
    if (!flow || flow.view.status === "done" || flow.view.status === "error") return false;
    flow.view = { ...flow.view, status: "cancelled", prompt: undefined };
    flow.controller.abort();
    flow.reject?.(new Error("登录已取消"));
    flow.answer = undefined;
    flow.reject = undefined;
    return true;
  }

  close() { for (const id of this.flows.keys()) this.cancel(id); this.flows.clear(); }
}
