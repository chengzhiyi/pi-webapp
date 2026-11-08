import type { HostedContribution } from "../../../../contracts/hosted-plugins.ts";
import { HostedPluginError } from "./errors.ts";
import type { OfficialPlugin } from "./official-catalog.ts";
import { MAX_WORKSPACE_FILE_BYTES, type HostedPluginPolicy, type SecretAuthPolicy, type WorkspaceFileRule } from "./plugin-policies.ts";
import { stableVersion } from "./versions.ts";

/** One plugin's complete host-side data: what the settings page shows, where to download it, and what it may do. */
export interface CatalogEntry extends OfficialPlugin { policy: HostedPluginPolicy }

/** Artwork keys the host ships. Anything else would be plugin-supplied markup, which the catalog never carries. */
export const CATALOG_ICONS = ["drawing", "design"] as const;
const PACKAGE_NAME = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const CAPABILITY = /^[a-z][a-z0-9.-]{0,79}$/;
const TOOL = /^[a-z][a-z0-9_]{0,63}$/;
const ACTION = /^[a-z][a-z0-9_-]{0,63}$/;
const SECRET = /^[a-z][a-z0-9-]{0,63}$/;

/** Strict reader: every field is typed, bounded and named in the error, and unknown keys are rejected so typos never pass silently. */
class Reader {
  readonly where: string;
  constructor(where: string) { this.where = where; }
  fail(path: string, message: string): never { throw new HostedPluginError("invalid_catalog", `${this.where}: ${path} ${message}`); }
  object(value: unknown, path: string, keys: readonly string[], required: readonly string[] = keys): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) this.fail(path, "must be an object");
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) if (!keys.includes(key)) this.fail(`${path}.${key}`, "is not a known field");
    for (const key of required) if (record[key] === undefined) this.fail(`${path}.${key}`, "is required");
    return record;
  }
  string(value: unknown, path: string, max = 200, pattern?: RegExp): string {
    if (typeof value !== "string" || !value.trim() || value.length > max) this.fail(path, `must be a non-empty string of at most ${max} characters`);
    if (pattern && !pattern.test(value)) this.fail(path, `has an invalid format (${JSON.stringify(value)})`);
    return value;
  }
  strings(value: unknown, path: string, pattern: RegExp, max = 64): string[] {
    if (!Array.isArray(value) || value.length > max) this.fail(path, `must be an array of at most ${max} strings`);
    const items = value.map((item, i) => this.string(item, `${path}[${i}]`, 80, pattern));
    if (new Set(items).size !== items.length) this.fail(path, "contains duplicates");
    return items;
  }
  text(value: unknown, path: string, max = 500): { zh: string; en: string } {
    const record = this.object(value, path, ["zh", "en"]);
    return { zh: this.string(record.zh, `${path}.zh`, max), en: this.string(record.en, `${path}.en`, max) };
  }
  integer(value: unknown, path: string, min: number, max: number): number {
    if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) this.fail(path, `must be an integer from ${min} to ${max}`);
    return value as number;
  }
  https(value: unknown, path: string, host?: string): string {
    const text = this.string(value, path, 2048);
    let url: URL;
    try { url = new URL(text); } catch { this.fail(path, "must be an absolute URL"); }
    if (url.protocol !== "https:" || url.username || url.password || url.hash || host !== undefined && url.hostname !== host) this.fail(path, `must be an https URL${host ? ` on ${host}` : ""} without credentials or fragment`);
    return text;
  }
  subset(items: readonly string[], of: readonly string[], path: string, what: string): void {
    for (const item of items) if (!of.includes(item)) this.fail(path, `lists "${item}", which is not one of its ${what}`);
  }
}

function contribution(r: Reader, value: unknown, path: string): HostedContribution {
  const c = r.object(value, path, ["entry", "panels", "artifactTools", "toolViews", "panelAlias"]);
  const entry = r.object(c.entry, `${path}.entry`, ["label", "description", "kind"]);
  const alias = r.object(c.panelAlias, `${path}.panelAlias`, ["prefix", "kind", "title"]);
  return {
    entry: { label: r.string(entry.label, `${path}.entry.label`, 64), description: r.text(entry.description, `${path}.entry.description`, 120), kind: r.string(entry.kind, `${path}.entry.kind`, 32, ACTION) },
    panels: r.strings(c.panels, `${path}.panels`, ACTION, 16), artifactTools: r.strings(c.artifactTools, `${path}.artifactTools`, TOOL, 128), toolViews: r.strings(c.toolViews, `${path}.toolViews`, TOOL, 128),
    panelAlias: { prefix: r.string(alias.prefix, `${path}.panelAlias.prefix`, 32, /^[a-z][a-z0-9-]{0,30}:$/), kind: r.string(alias.kind, `${path}.panelAlias.kind`, 32, ACTION), title: r.string(alias.title, `${path}.panelAlias.title`, 64) },
  };
}

function workspaceFiles(r: Reader, value: unknown, path: string): WorkspaceFileRule[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) r.fail(path, "must be an array of 1 to 16 rules");
  return value.map((raw, i) => {
    const p = `${path}[${i}]`, rule = r.object(raw, p, ["extension", "binary", "maxBytes", "createDirectory"], ["extension", "binary", "maxBytes"]);
    if (typeof rule.binary !== "boolean") r.fail(`${p}.binary`, "must be a boolean");
    return {
      extension: r.string(rule.extension, `${p}.extension`, 17, /^\.[a-z0-9]{1,16}$/), binary: rule.binary, maxBytes: r.integer(rule.maxBytes, `${p}.maxBytes`, 1, MAX_WORKSPACE_FILE_BYTES),
      ...(rule.createDirectory !== undefined ? { createDirectory: r.string(rule.createDirectory, `${p}.createDirectory`, 64, /^[A-Za-z0-9_-]{1,64}$/) } : {}),
    };
  });
}

function secrets(r: Reader, value: unknown, path: string): Record<string, SecretAuthPolicy> {
  const record = r.object(value, path, Object.keys(value && typeof value === "object" ? value : {}), []);
  if (Object.keys(record).length > 16) r.fail(path, "declares more than 16 secrets");
  return Object.fromEntries(Object.entries(record).map(([name, raw]) => {
    const p = `${path}.${name}`;
    r.string(name, `${path} key`, 64, SECRET);
    const auth = r.object(raw, p, ["provider", "scope", "createUrl", "clientId"], ["provider", "scope", "createUrl"]);
    if (auth.provider !== "github") r.fail(`${p}.provider`, `must be "github" (the only sign-in the host implements)`);
    return [name, {
      provider: "github" as const, scope: r.string(auth.scope, `${p}.scope`, 200, /^[\w:. -]+$/), createUrl: r.https(auth.createUrl, `${p}.createUrl`, "github.com"),
      ...(auth.clientId !== undefined ? { clientId: r.string(auth.clientId, `${p}.clientId`, 64, /^[A-Za-z0-9._-]+$/) } : {}),
    }];
  }));
}

/** Validates one reviewed policy. The package itself can never widen what is accepted here. */
export function parsePolicy(value: unknown, where: string, path = "policy"): HostedPluginPolicy {
  const r: Reader = new Reader(where);
  const p = r.object(value, path, ["tools", "readonlyActions", "actions", "checkpointActions", "contribution", "browser", "workspace", "runtime", "secrets"], ["tools", "readonlyActions", "actions", "checkpointActions", "contribution"]);
  const tools = r.object(p.tools, `${path}.tools`, Object.keys(p.tools && typeof p.tools === "object" ? p.tools : {}), []);
  if (Object.keys(tools).length > 128) r.fail(`${path}.tools`, "declares more than 128 tools");
  for (const [name, action] of Object.entries(tools)) { r.string(name, `${path}.tools key`, 64, TOOL); r.string(action, `${path}.tools.${name}`, 64, ACTION); }
  const toolNames = Object.keys(tools), toolActions = Object.values(tools) as string[];
  const readonlyActions = r.strings(p.readonlyActions, `${path}.readonlyActions`, ACTION);
  const actions = r.strings(p.actions, `${path}.actions`, ACTION);
  const checkpointActions = r.strings(p.checkpointActions, `${path}.checkpointActions`, ACTION);
  r.subset(readonlyActions, toolActions, `${path}.readonlyActions`, "tool actions");
  r.subset(checkpointActions, actions, `${path}.checkpointActions`, "actions");
  const contributes = contribution(r, p.contribution, `${path}.contribution`);
  r.subset(contributes.artifactTools, toolNames, `${path}.contribution.artifactTools`, "tools");
  r.subset(contributes.toolViews, toolNames, `${path}.contribution.toolViews`, "tools");
  const policy: HostedPluginPolicy = { tools: tools as Record<string, string>, readonlyActions, actions, checkpointActions, contribution: contributes };
  if (p.browser !== undefined) {
    const browser = r.object(p.browser, `${path}.browser`, ["wasm"], []);
    if (browser.wasm !== undefined && typeof browser.wasm !== "boolean") r.fail(`${path}.browser.wasm`, "must be a boolean");
    policy.browser = browser.wasm === undefined ? {} : { wasm: browser.wasm as boolean };
  }
  if (p.workspace !== undefined) policy.workspace = { files: workspaceFiles(r, r.object(p.workspace, `${path}.workspace`, ["files"]).files, `${path}.workspace.files`) };
  if (p.runtime !== undefined) {
    const runtime = r.object(p.runtime, `${path}.runtime`, ["invokeTimeoutMs"], []);
    policy.runtime = runtime.invokeTimeoutMs === undefined ? {} : { invokeTimeoutMs: r.integer(runtime.invokeTimeoutMs, `${path}.runtime.invokeTimeoutMs`, 1_000, 180_000) };
  }
  if (p.secrets !== undefined) policy.secrets = secrets(r, p.secrets, `${path}.secrets`);
  return policy;
}

const ENTRY_KEYS = ["id", "name", "icon", "description", "registry", "recommendedVersion", "requiredCapabilities", "reviewed", "policy"] as const;
/** Validates one catalog entry: the shape shared by the bundled official file and a dev package's own `piWebappCatalog` block. */
export function parseCatalogEntry(value: unknown, where: string, path = "plugin"): CatalogEntry {
  const r: Reader = new Reader(where);
  const e = r.object(value, path, ENTRY_KEYS, ["id", "name", "description", "registry", "recommendedVersion", "requiredCapabilities", "policy"]);
  const id = r.string(e.id, `${path}.id`, 214, PACKAGE_NAME);
  if (e.icon !== undefined && !(CATALOG_ICONS as readonly unknown[]).includes(e.icon)) r.fail(`${path}.icon`, `must be one of ${CATALOG_ICONS.join(", ")}`);
  const registry = r.https(e.registry, `${path}.registry`);
  if (new URL(registry).origin !== registry) r.fail(`${path}.registry`, "must be a bare origin such as https://registry.npmjs.org");
  const recommendedVersion = r.string(e.recommendedVersion, `${path}.recommendedVersion`, 64);
  if (!stableVersion(recommendedVersion)) r.fail(`${path}.recommendedVersion`, "must be a stable x.y.z version");
  if (e.reviewed !== undefined) r.string(e.reviewed, `${path}.reviewed`, 1000);
  return {
    id, name: r.string(e.name, `${path}.name`, 64), ...(e.icon !== undefined ? { icon: e.icon as CatalogEntry["icon"] } : {}),
    description: r.text(e.description, `${path}.description`), registry, recommendedVersion,
    requiredCapabilities: r.strings(e.requiredCapabilities, `${path}.requiredCapabilities`, CAPABILITY),
    policy: parsePolicy(e.policy, where, `${path}.policy`),
  };
}

/** Validates a whole catalog document (`{ schemaVersion: 1, plugins: [...] }`); ids must be unique. */
export function parseCatalog(value: unknown, where: string): CatalogEntry[] {
  const r: Reader = new Reader(where);
  const doc = r.object(value, "catalog", ["schemaVersion", "plugins"]);
  if (doc.schemaVersion !== 1) r.fail("catalog.schemaVersion", "must be 1");
  if (!Array.isArray(doc.plugins) || doc.plugins.length > 64) r.fail("catalog.plugins", "must be an array of at most 64 entries");
  const entries = doc.plugins.map((item, i) => parseCatalogEntry(item, where, `catalog.plugins[${i}]`));
  const ids = entries.map(entry => entry.id);
  for (const [i, id] of ids.entries()) if (ids.indexOf(id) !== i) r.fail(`catalog.plugins[${i}].id`, `duplicates ${id}`);
  return entries;
}

/** Deep-freezes parsed data so no consumer can widen a reviewed policy at runtime. */
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child); }
  return value;
}
