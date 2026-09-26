import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addCustomProvider } from "../extension/custom-provider.ts";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

test("adds a compatible Pi provider without storing its API key or replacing existing providers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-provider-"));
  const path = join(dir, "models.json");
  try {
    await writeFile(path, JSON.stringify({ providers: { existing: { baseUrl: "https://existing.example/v1", api: "openai-completions", models: [{ id: "old" }] } } }));
    const runtime = await ModelRuntime.create({ modelsPath: path, authPath: join(dir, "auth.json"), refreshOnCreate: false });
    await runtime.refresh({ allowNetwork: false });
    assert.equal(runtime.getProvider("my-api"), undefined);
    await addCustomProvider(path, { id: "my-api", name: "My API", baseUrl: "https://api.example.com/v1", api: "openai-completions", modelId: "chat-1" });
    const saved = JSON.parse(await readFile(path, "utf8"));
    assert.equal(saved.providers.existing.models[0].id, "old");
    assert.deepEqual(saved.providers["my-api"], { name: "My API", baseUrl: "https://api.example.com/v1", api: "openai-completions", models: [{ id: "chat-1" }] });
    assert.equal((await readFile(path, "utf8")).includes("apiKey"), false);
    await runtime.refresh({ allowNetwork: false });
    assert.equal(runtime.getModel("my-api", "chat-1")?.provider, "my-api");
    assert.equal(typeof runtime.getProvider("my-api")?.auth.apiKey?.login, "function");
    await assert.rejects(addCustomProvider(path, { id: "my-api", name: "Again", baseUrl: "https://api.example.com/v1", api: "openai-completions", modelId: "other" }), /已存在/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("rejects invalid endpoints and does not rewrite commented models.json", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-provider-"));
  const path = join(dir, "models.json");
  const input = { id: "private", name: "Private", baseUrl: "https://api.example.com/v1", api: "openai-completions" as const, modelId: "chat" };
  try {
    await assert.rejects(addCustomProvider(path, { ...input, baseUrl: "file:///tmp/models" }), /地址/);
    await assert.rejects(addCustomProvider(path, { ...input, baseUrl: "https://user:password@api.example.com/v1" }), /地址/);
    await writeFile(path, '{ "providers": {} // keep this comment\n}');
    await assert.rejects(addCustomProvider(path, input), /注释/);
    assert.equal(await readFile(path, "utf8"), '{ "providers": {} // keep this comment\n}');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
