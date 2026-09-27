import assert from "node:assert/strict";
import test from "node:test";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import { preferBrowserLogin, ProviderLoginController } from "../extension/provider-login.ts";

test("OpenAI Codex browser sign-in skips the redundant method prompt", async () => {
  let prompted = false;
  const interaction: AuthInteraction = {
    signal: new AbortController().signal,
    notify() {},
    async prompt() { prompted = true; return "device_code"; },
  };
  const method = await preferBrowserLogin("openai-codex", "oauth", interaction).prompt({
    type: "select", message: "Select OpenAI Codex login method:",
    options: [{ id: "browser", label: "Browser login" }, { id: "device_code", label: "Device code" }],
  });
  assert.equal(method, "browser");
  assert.equal(prompted, false);
  assert.equal(preferBrowserLogin("anthropic", "oauth", interaction), interaction);
});

test("OAuth authorization URL survives later progress while waiting for the callback", async () => {
  const controller = new ProviderLoginController();
  const flow = controller.start("openai-codex", "oauth", async (_provider, _method, interaction) => {
    interaction.notify({ type: "auth_url", url: "https://auth.example.test/authorize" });
    interaction.notify({ type: "progress", message: "Waiting for callback" });
    await interaction.prompt({ type: "manual_code", message: "Fallback code" });
  });
  const waiting = controller.get(flow.id);
  assert.equal(waiting?.status, "waiting");
  assert.equal(waiting?.event?.type, "progress");
  assert.deepEqual(waiting?.authorization, { type: "auth_url", url: "https://auth.example.test/authorize" });
  assert.equal(controller.respond(flow.id, "code"), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.get(flow.id)?.status, "done");
});

test("an unfinished login can be resumed without starting another provider login", async () => {
  const controller = new ProviderLoginController();
  let starts = 0;
  const login = async (_provider: string, _method: "oauth" | "api_key", interaction: AuthInteraction) => {
    starts++;
    interaction.notify({ type: "auth_url", url: "https://auth.example.test/authorize" });
    await interaction.prompt({ type: "manual_code", message: "Fallback code" });
  };
  const first = controller.start("openai-codex", "oauth", login);
  assert.equal(controller.getActive()?.id, first.id);
  assert.equal(controller.start("openai-codex", "oauth", login).id, first.id);
  assert.equal(starts, 1);
  assert.throws(() => controller.start("anthropic", "oauth", login), /其他提供方的登录正在进行/);
  assert.equal(controller.cancel(first.id), true);
  assert.equal(controller.getActive(), undefined);
});

test("inline API key answers only the secret prompt and never enters the public login view", async () => {
  const controller = new ProviderLoginController();
  let received = "";
  const flow = controller.start("deepseek", "api_key", async (_provider, _method, interaction) => {
    received = await interaction.prompt({ type: "secret", message: "API key" });
  }, "sk-inline-test");
  assert.equal(JSON.stringify(controller.get(flow.id)).includes("sk-inline-test"), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(received, "sk-inline-test");
  assert.equal(controller.get(flow.id)?.status, "done");
});
