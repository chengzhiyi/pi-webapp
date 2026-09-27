import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getProviderModels, updateProviderModel } from "../extension/provider-model-config.ts";

test("edits built-in models as overrides and preserves unrelated provider configuration", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-models-"));
  const path = join(dir, "models.json");
  try {
    await writeFile(path, JSON.stringify({ providers: { deepseek: { headers: { "X-Test": "keep" }, modelOverrides: { "deepseek-flash": { cost: { input: 2 } } } } } }));
    const runtime = await ModelRuntime.create({ modelsPath: path, authPath: join(dir, "auth.json"), refreshOnCreate: false });
    await runtime.refresh({ allowNetwork: false });
    const view = await getProviderModels(path, "deepseek", runtime);
    assert.equal(view.models.find((model) => model.id === "deepseek-flash")?.source, "builtin");
    await updateProviderModel(path, "deepseek", { action: "save", originalId: "deepseek-flash", model: { id: "deepseek-flash", name: "Flash custom", contextWindow: 1000000, maxTokens: 256000, input: ["text", "image"] } }, runtime);
    const saved = JSON.parse(await readFile(path, "utf8"));
    assert.equal(saved.providers.deepseek.headers["X-Test"], "keep");
    assert.equal(saved.providers.deepseek.modelOverrides["deepseek-flash"].cost.input, 2);
    assert.equal(saved.providers.deepseek.modelOverrides["deepseek-flash"].maxTokens, 256000);
    await runtime.refresh({ allowNetwork: false });
    assert.equal(runtime.getModel("deepseek", "deepseek-flash")?.contextWindow, 1000000);
    assert.equal(runtime.getModel("deepseek", "deepseek-flash")?.maxTokens, 256000);
    await updateProviderModel(path, "deepseek", { action: "remove", id: "deepseek-flash" }, runtime);
    assert.equal(JSON.parse(await readFile(path, "utf8")).providers.deepseek.modelOverrides, undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("adds and removes custom models without deleting built-in models", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-models-"));
  const path = join(dir, "models.json");
  try {
    const runtime = await ModelRuntime.create({ modelsPath: path, authPath: join(dir, "auth.json"), refreshOnCreate: false });
    await updateProviderModel(path, "deepseek", { action: "save", model: { id: "my-model", name: "My model", contextWindow: 128000, maxTokens: 32000, input: ["text"] } }, runtime);
    await runtime.refresh({ allowNetwork: false });
    assert.equal(runtime.getModel("deepseek", "my-model")?.name, "My model");
    await assert.rejects(updateProviderModel(path, "deepseek", { action: "save", model: { id: "my-model" } }, runtime), /已存在/);
    await updateProviderModel(path, "deepseek", { action: "remove", id: "my-model" }, runtime);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")).providers, {});
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("refuses invalid model values and leaves commented configuration untouched", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-models-"));
  const path = join(dir, "models.json");
  try {
    const runtime = await ModelRuntime.create({ modelsPath: path, authPath: join(dir, "auth.json"), refreshOnCreate: false });
    await assert.rejects(updateProviderModel(path, "deepseek", { action: "save", model: { id: "bad", maxTokens: -1 } }, runtime), /模型参数/);
    await writeFile(path, '{ "providers": {} // hand edited\n}');
    await assert.rejects(updateProviderModel(path, "deepseek", { action: "save", model: { id: "new" } }, runtime), /注释/);
    assert.equal(await readFile(path, "utf8"), '{ "providers": {} // hand edited\n}');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("ignores fields outside the curated model editor", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-models-"));
  const path = join(dir, "models.json");
  try {
    const runtime = await ModelRuntime.create({ modelsPath: path, authPath: join(dir, "auth.json"), refreshOnCreate: false });
    await updateProviderModel(path, "deepseek", { action: "save", model: { id: "safe", baseUrl: "https://wrong.example", apiKey: "secret" } as never }, runtime);
    const saved = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(saved.providers.deepseek.models, [{ id: "safe" }]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("provider API URL overrides requests and can be restored without losing model edits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-models-"));
  const path = join(dir, "models.json");
  try {
    const runtime = await ModelRuntime.create({ modelsPath: path, authPath: join(dir, "auth.json"), refreshOnCreate: false });
    const original = runtime.getModel("deepseek", "deepseek-flash")?.baseUrl;
    await updateProviderModel(path, "deepseek", { action: "base_url", baseUrl: "https://proxy.example.test/v1" }, runtime);
    await runtime.refresh({ allowNetwork: false });
    assert.equal(runtime.getModel("deepseek", "deepseek-flash")?.baseUrl, "https://proxy.example.test/v1");
    assert.equal((await getProviderModels(path, "deepseek", runtime)).baseUrl, "https://proxy.example.test/v1");
    await updateProviderModel(path, "deepseek", { action: "save", originalId: "deepseek-flash", model: { id: "deepseek-flash", name: "Custom flash" } }, runtime);
    await updateProviderModel(path, "deepseek", { action: "base_url", baseUrl: null }, runtime);
    await runtime.refresh({ allowNetwork: false });
    assert.equal(runtime.getModel("deepseek", "deepseek-flash")?.baseUrl, original);
    assert.equal(JSON.parse(await readFile(path, "utf8")).providers.deepseek.modelOverrides["deepseek-flash"].name, "Custom flash");
    await assert.rejects(updateProviderModel(path, "deepseek", { action: "base_url", baseUrl: "file:///tmp/secret" }, runtime), /地址/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
