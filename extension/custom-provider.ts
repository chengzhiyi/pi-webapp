import { randomBytes } from "node:crypto";
import { readFile, rename, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export const customProviderApis = ["openai-completions", "openai-responses", "anthropic-messages"] as const;
export type CustomProviderApi = typeof customProviderApis[number];
export interface CustomProviderInput { id: string; name: string; baseUrl: string; api: CustomProviderApi; modelId: string }

export function validCustomProviderInput(value: unknown): value is CustomProviderInput {
  if (!value || typeof value !== "object") return false;
  const input = value as Partial<CustomProviderInput>;
  if (typeof input.id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(input.id)) return false;
  if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 100) return false;
  if (typeof input.modelId !== "string" || !input.modelId.trim() || input.modelId.length > 200) return false;
  if (!customProviderApis.includes(input.api as CustomProviderApi)) return false;
  if (typeof input.baseUrl !== "string" || input.baseUrl.length > 2048) return false;
  try {
    const url = new URL(input.baseUrl);
    return (url.protocol === "https:" || url.protocol === "http:") && Boolean(url.hostname) && !url.username && !url.password && !url.hash;
  } catch { return false; }
}

/** Add a Pi models.json definition. Credentials are added later through Pi's auth runtime. */
export async function addCustomProvider(path: string, input: CustomProviderInput): Promise<void> {
  if (!validCustomProviderInput(input)) throw new Error("自定义提供方名称、地址或模型无效");
  let existing: string | undefined;
  try { existing = await readFile(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  let config: { providers: Record<string, unknown>; [key: string]: unknown };
  if (existing === undefined) config = { providers: {} };
  else {
    try { config = JSON.parse(existing) as typeof config; }
    catch { throw new Error("models.json 含注释或格式错误，请在配置文件中手动添加提供方"); }
    if (!config || typeof config !== "object" || !config.providers || typeof config.providers !== "object" || Array.isArray(config.providers)) throw new Error("models.json 结构无效");
  }
  if (Object.hasOwn(config.providers, input.id)) throw new Error("提供方已存在");
  const next = { ...config, providers: { ...config.providers, [input.id]: {
    name: input.name.trim(), baseUrl: input.baseUrl, api: input.api, models: [{ id: input.modelId.trim() }],
  } } };
  await mkdir(dirname(path), { recursive: true });
  const mode = existing === undefined ? 0o600 : (await stat(path)).mode & 0o777;
  const temporary = `${path}.pi-web-${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode, flag: "wx" });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}
