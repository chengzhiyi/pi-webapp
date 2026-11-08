import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCatalog, parseCatalogEntry } from "../src/host/server/plugins/hosted/catalog-schema.ts";
import { DEFAULT_POLICIES, OFFICIAL_ENTRIES, OFFICIAL_PLUGINS } from "../src/host/server/plugins/hosted/official-catalog.ts";

const EXCALIDRAW = "@chengzhiyi/pi-excalidraw", PENCIL = "@chengzhiyi/pi-pencil";
const invalid = (pattern: RegExp) => (error: unknown) => (error as { code?: string }).code === "invalid_catalog" && pattern.test((error as Error).message);
// biome-ignore lint/suspicious/noExplicitAny: these tests deliberately corrupt arbitrary nested fields.
type Loose = Record<string, any>;
const entry = () => structuredClone(OFFICIAL_ENTRIES.find(e => e.id === PENCIL)!) as unknown as Loose;

test("official-plugins.json lists exactly the released plugins, in order", () => {
  assert.deepEqual(OFFICIAL_PLUGINS.map(p => [p.id, p.name, p.icon, p.recommendedVersion]), [[EXCALIDRAW, "Excalidraw", "drawing", "0.1.0"], [PENCIL, "OpenPencil", "design", "0.0.2"]]);
  assert.deepEqual([...DEFAULT_POLICIES.keys()], [EXCALIDRAW, PENCIL]);
  assert.ok(OFFICIAL_PLUGINS.every(p => !("policy" in p) && p.official === undefined), "catalog cards carry no policy and stay official");
});

test("the data file reproduces the previously hardcoded policies field for field", () => {
  assert.deepEqual(DEFAULT_POLICIES.get(EXCALIDRAW), {
    tools: { excalidraw_read_me: "reference", excalidraw_create_view: "view", diagram_reference: "reference", diagram_create: "create", diagram_read: "read", diagram_patch: "patch" },
    readonlyActions: ["read", "reference"], actions: ["list", "new", "open", "import", "get", "focus", "sync", "initialize", "accept", "reject", "save"], checkpointActions: ["sync", "get", "list"],
    contribution: { entry: { label: "Excalidraw", description: { zh: "手绘图稿", en: "Editable drawings" }, kind: "workspace" }, panels: ["workspace", "editor"], artifactTools: ["excalidraw_create_view", "diagram_create", "diagram_patch"],
      toolViews: ["excalidraw_create_view", "diagram_create", "diagram_patch"], panelAlias: { prefix: "diagram:", kind: "editor", title: "Excalidraw" } },
  });
  assert.deepEqual(DEFAULT_POLICIES.get(PENCIL), {
    tools: { pencil_read_me: "reference", pencil_status: "status", pencil_inspect: "inspect", pencil_render: "render", pencil_apply_changes: "apply" },
    readonlyActions: ["reference", "status", "inspect", "render"], actions: ["list", "get", "accept", "reject", "revert", "save", "open", "create", "rename", "selection", "sync", "lock"], checkpointActions: ["get", "list", "sync", "create"],
    contribution: { entry: { label: "OpenPencil", description: { zh: "UI 设计", en: "UI design" }, kind: "workspace" }, panels: ["workspace", "editor"], artifactTools: ["pencil_apply_changes"], toolViews: [], panelAlias: { prefix: "pencil:", kind: "editor", title: "OpenPencil" } },
    browser: { wasm: true }, workspace: { files: [{ extension: ".fig", binary: true, maxBytes: 64 * 1024 * 1024, createDirectory: "designs" }] }, runtime: { invokeTimeoutMs: 120_000 },
  });
});

test("parsed official data is frozen all the way down", () => {
  const policy = DEFAULT_POLICIES.get(PENCIL)!;
  assert.throws(() => { (policy.actions as string[]).push("delete"); }, TypeError);
  assert.throws(() => { (policy.tools as Record<string, string>).pencil_delete = "delete"; }, TypeError);
  assert.throws(() => { (policy.workspace!.files[0] as { maxBytes: number }).maxBytes = 1; }, TypeError);
  assert.throws(() => { (OFFICIAL_PLUGINS[0] as { registry: string }).registry = "https://evil.example"; }, TypeError);
});

test("the validator rejects malformed entries with the field that is wrong", () => {
  const where = "test.json";
  const reject = (mutate: (e: Loose) => void, pattern: RegExp) => { const e = entry(); mutate(e); assert.throws(() => parseCatalogEntry(e, where), invalid(pattern)); };
  reject(e => { e.extra = 1; }, /plugin\.extra is not a known field/);
  reject(e => { delete e.policy; }, /plugin\.policy is required/);
  reject(e => { e.id = "Not A Package"; }, /plugin\.id has an invalid format/);
  reject(e => { e.icon = "github"; }, /plugin\.icon must be one of drawing/);
  reject(e => { e.registry = "http://registry.npmjs.org"; }, /plugin\.registry must be an https URL/);
  reject(e => { e.registry = "https://registry.npmjs.org/some/path"; }, /plugin\.registry must be a bare origin/);
  reject(e => { e.recommendedVersion = "0.0.0-stage"; }, /recommendedVersion must be a stable x\.y\.z version/);
  reject(e => { e.requiredCapabilities = ["State"]; }, /requiredCapabilities\[0\] has an invalid format/);
  reject(e => { e.policy.tools.Bad = "x"; }, /policy\.tools key has an invalid format/);
  reject(e => { e.policy.readonlyActions = ["delete"]; }, /readonlyActions lists "delete", which is not one of its tool actions/);
  reject(e => { e.policy.checkpointActions = ["delete"]; }, /checkpointActions lists "delete", which is not one of its actions/);
  reject(e => { e.policy.contribution.artifactTools = ["pencil_delete"]; }, /artifactTools lists "pencil_delete", which is not one of its tools/);
  reject(e => { e.policy.workspace.files[0].maxBytes = 64 * 1024 * 1024 + 1; }, /files\[0\]\.maxBytes must be an integer/);
  reject(e => { e.policy.workspace.files[0].extension = "fig"; }, /files\[0\]\.extension has an invalid format/);
  reject(e => { e.policy.runtime.invokeTimeoutMs = 999_999; }, /invokeTimeoutMs must be an integer from 1000 to 180000/);
  reject(e => { e.policy.browser.wasm = "yes"; }, /browser\.wasm must be a boolean/);
  reject(e => { e.policy.secrets = { token: { provider: "github", scope: "repo", createUrl: "https://evil.example/new" } }; }, /createUrl must be an https URL on github\.com/);
  assert.doesNotThrow(() => parseCatalogEntry(entry(), where));
});

test("a catalog document needs schemaVersion 1 and unique ids", () => {
  assert.throws(() => parseCatalog({ schemaVersion: 2, plugins: [] }, "x"), invalid(/schemaVersion must be 1/));
  assert.throws(() => parseCatalog({ schemaVersion: 1, plugins: [entry(), entry()] }, "x"), invalid(/plugins\[1\]\.id duplicates @chengzhiyi\/pi-pencil/));
  assert.deepEqual(parseCatalog({ schemaVersion: 1, plugins: [] }, "x"), []);
});

test("host source names no plugin outside the data file (Excalidraw's legacy-drawing migration excepted)", async () => {
  const root = new URL("../src/", import.meta.url).pathname, offenders: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, item.name);
      if (item.isDirectory()) await walk(path);
      else if (/\.(ts|tsx|mjs|js)$/.test(item.name) && /pi-github|pi-pencil/.test(await readFile(path, "utf8"))) offenders.push(path.slice(root.length));
    }
  };
  await walk(root);
  assert.deepEqual(offenders, []);
});
