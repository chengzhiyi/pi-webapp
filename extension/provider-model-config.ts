import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

export interface ModelFields {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  input?: Array<"text" | "image">;
}
export interface ModelRow extends ModelFields { source: "builtin" | "custom"; overridden: boolean }
export interface ProviderModelsView { providerId: string; baseUrl?: string; models: ModelRow[] }
export type ModelChange = { action: "save"; originalId?: string; model: ModelFields } | { action: "remove"; id: string } | { action: "base_url"; baseUrl: string | null };

function validBaseUrl(value: string): boolean {
  if (!value || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && Boolean(url.hostname) && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

export function validModelChange(value: unknown): value is ModelChange {
  if (!value || typeof value !== "object") return false;
  const change = value as Partial<ModelChange>;
  if (change.action === "save") return (change.originalId === undefined || typeof change.originalId === "string") && validModel(change.model);
  if (change.action === "base_url") return change.baseUrl === null || (typeof change.baseUrl === "string" && validBaseUrl(change.baseUrl));
  return change.action === "remove" && typeof change.id === "string" && change.id.length > 0 && change.id.length <= 200;
}

interface ProviderConfig {
  baseUrl?: string;
  models?: ModelFields[];
  modelOverrides?: Record<string, Partial<ModelFields> & Record<string, unknown>>;
  [key: string]: unknown;
}
interface ModelsFile { providers: Record<string, ProviderConfig>; [key: string]: unknown }

function validModel(model: unknown): model is ModelFields {
  if (!model || typeof model !== "object") return false;
  const value = model as Partial<ModelFields>;
  if (typeof value.id !== "string" || !value.id.trim() || value.id.length > 200) return false;
  if (value.name !== undefined && (typeof value.name !== "string" || !value.name.trim() || value.name.length > 200)) return false;
  for (const number of [value.contextWindow, value.maxTokens]) {
    if (number !== undefined && (!Number.isSafeInteger(number) || number <= 0)) return false;
  }
  return value.input === undefined || (Array.isArray(value.input) && value.input.length > 0 && value.input.every((item) => item === "text" || item === "image") && new Set(value.input).size === value.input.length);
}

async function readModelsFile(path: string): Promise<{ config: ModelsFile; existing?: string }> {
  let existing: string | undefined;
  try { existing = await readFile(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (existing === undefined) return { config: { providers: {} } };
  let config: ModelsFile;
  try { config = JSON.parse(existing) as ModelsFile; }
  catch { throw new Error("models.json 含注释或格式错误，请在配置文件中手动修改"); }
  if (!config || typeof config !== "object" || !config.providers || typeof config.providers !== "object" || Array.isArray(config.providers)) throw new Error("models.json 结构无效");
  return { config, existing };
}

async function writeModelsFile(path: string, config: ModelsFile, existing?: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const mode = existing === undefined ? 0o600 : (await stat(path)).mode & 0o777;
  const temporary = `${path}.pi-web-${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode, flag: "wx" });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

/** Return Pi's effective model catalog with the saved customization source for each row. */
export async function getProviderModels(path: string, providerId: string, runtime: ModelRuntime): Promise<ProviderModelsView> {
  if (!runtime.getProvider(providerId)) throw new Error("提供方不存在");
  const { config } = await readModelsFile(path);
  const provider = config.providers[providerId];
  const custom = new Set(provider?.models?.map((model) => model.id) ?? []);
  return {
    providerId,
    baseUrl: provider?.baseUrl,
    models: runtime.getModels(providerId).map((model) => ({
      id: model.id, name: model.name, contextWindow: model.contextWindow, maxTokens: model.maxTokens,
      input: [...model.input], source: custom.has(model.id) ? "custom" : "builtin",
      overridden: Boolean(provider?.modelOverrides?.[model.id]),
    })),
  };
}

/** Apply one model edit without rebuilding unrelated fields or provider definitions. */
export async function updateProviderModel(path: string, providerId: string, change: ModelChange, runtime: ModelRuntime): Promise<void> {
  if (!runtime.getProvider(providerId)) throw new Error("提供方不存在");
  const { config, existing } = await readModelsFile(path);
  const provider = { ...(config.providers[providerId] ?? {}) };
  const models = [...(provider.models ?? [])];
  const overrides = { ...(provider.modelOverrides ?? {}) };
  if (change.action === "base_url") {
    if (change.baseUrl !== null && !validBaseUrl(change.baseUrl)) throw new Error("API 地址无效");
    if (change.baseUrl === null) delete provider.baseUrl;
    else provider.baseUrl = change.baseUrl;
  } else if (change.action === "save") {
    if (!validModel(change.model)) throw new Error("模型参数无效");
    const model: ModelFields = {
      id: change.model.id.trim(),
      ...(change.model.name === undefined ? {} : { name: change.model.name }),
      ...(change.model.contextWindow === undefined ? {} : { contextWindow: change.model.contextWindow }),
      ...(change.model.maxTokens === undefined ? {} : { maxTokens: change.model.maxTokens }),
      ...(change.model.input === undefined ? {} : { input: change.model.input }),
    };
    const originalId = change.originalId;
    const index = originalId === undefined ? -1 : models.findIndex((item) => item.id === originalId);
    if (originalId === undefined && (models.some((item) => item.id === model.id) || runtime.getModel(providerId, model.id))) throw new Error("模型 ID 已存在");
    if (index >= 0) {
      if (model.id !== originalId && (models.some((item) => item.id === model.id) || runtime.getModel(providerId, model.id))) throw new Error("模型 ID 已存在");
      const next = { ...models[index], ...model };
      for (const field of ["name", "contextWindow", "maxTokens", "input"] as const) if (model[field] === undefined) delete next[field];
      models[index] = next;
    } else if (originalId !== undefined && runtime.getModel(providerId, originalId)) {
      if (model.id !== originalId) throw new Error("内置模型 ID 不可修改");
      const { id: _id, ...fields } = model;
      overrides[originalId] = { ...overrides[originalId], ...fields };
      for (const field of ["name", "contextWindow", "maxTokens", "input"] as const) if (model[field] === undefined) delete overrides[originalId][field];
    } else if (originalId !== undefined) throw new Error("模型不存在");
    else models.push(model);
  } else {
    const index = models.findIndex((item) => item.id === change.id);
    if (index >= 0) models.splice(index, 1);
    else if (Object.hasOwn(overrides, change.id)) delete overrides[change.id];
    else throw new Error("只能移除自定义模型或恢复已修改的内置模型");
  }
  if (models.length) provider.models = models; else delete provider.models;
  if (Object.keys(overrides).length) provider.modelOverrides = overrides; else delete provider.modelOverrides;
  if (Object.keys(provider).length) config.providers[providerId] = provider;
  else delete config.providers[providerId];
  await writeModelsFile(path, config, existing);
}
