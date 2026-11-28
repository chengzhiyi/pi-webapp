import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { join, posix, relative, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const repoPath = (absolute: string) => relative(root, absolute).split(sep).join("/");
const browserModule = /^(?:web\/src\/|src\/host\/client\/|src\/plugins\/builtin\/(?:client\.ts$|[^/]+\/client\/))/;
const policyModule = /^(?:web\/src\/|src\/(?:adapters\/|contracts\/|host\/|platform\/))/;
const builtinPluginPath = /^src\/plugins\/builtin\/[^/]+\/(.+)$/;
const publicPluginPath = /^(?:contract\/|(?:client|server)\/public\.[cm]?[jt]sx?$)/;
const serverModule = /^(?:bin\/|desktop\/(?!docs-links\.mjs$)|src\/(?:host\/server\/|adapters\/pi\/|plugins\/builtin\/(?:server\.ts$|[^/]+\/server\/)))/;
const piRuntime = /^@earendil-works\/pi-(?:ai|coding-agent)(?:\/|$)/;
const extensions = [".ts", ".tsx", ".mjs", ".js", ".jsx", ".cjs", ".mts", ".cts"];

type ImportGraph = Map<string, string[]>;
function dependencyViolations(graph: ImportGraph): string[] {
  const targetOf = (file: string, specifier: string) => {
    const path = posix.resolve("/", posix.dirname(file), specifier.split("?")[0]).slice(1);
    if (graph.has(path)) return path;
    return [path, `${path}/index`].flatMap(base => extensions.map(ext => base + ext)).find(candidate => graph.has(candidate)) ?? path;
  };
  const violations = new Set<string>();
  const browserVisited = new Set<string>();
  function visitBrowser(file: string, chain: string[]) {
    if (browserVisited.has(file)) return;
    browserVisited.add(file);
    for (const specifier of graph.get(file) ?? []) {
      const local = specifier.startsWith(".");
      const target = local ? targetOf(file, specifier) : specifier;
      if (local ? serverModule.test(target) : isBuiltin(target) || piRuntime.test(target) || target === "electron") {
        violations.add(`Browser runtime: ${[...chain, file, target].join(" -> ")}`);
      } else if (local) visitBrowser(target, [...chain, file]);
    }
  }
  for (const [file, specifiers] of graph) {
    if (policyModule.test(file)) for (const specifier of specifiers) {
      if (!specifier.startsWith(".")) continue;
      const target = targetOf(file, specifier);
      const plugin = builtinPluginPath.exec(target);
      if (plugin && !publicPluginPath.test(plugin[1])) violations.add(`Private builtin module: ${file} -> ${target}`);
    }
    if (browserModule.test(file)) visitBrowser(file, []);
  }
  return [...violations].sort();
}

async function sourceImports(): Promise<ImportGraph> {
  const files = (await Promise.all(["src", "web/src"].map(dir => readdir(join(root, dir), { recursive: true, withFileTypes: true })))).flat()
    .filter(entry => entry.isFile() && /\.(?:[cm]?[jt]s|[jt]sx)$/.test(entry.name) && !/\.d\.[cm]?ts$/.test(entry.name))
    .map(entry => repoPath(join(entry.parentPath, entry.name)));
  files.push("desktop/docs-links.mjs"); // Browser-safe static links shared with the native shell.
  const graph: ImportGraph = new Map(files.map(file => [file, []]));
  await build({
    absWorkingDir: root, entryPoints: files, outdir: "architecture-check", write: false, bundle: true,
    logLevel: "silent", format: "esm", tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true } },
    plugins: [{ name: "architecture-imports", setup(builder) {
      // Parse all first-party source, including re-exports and literal import()
      // calls, but do not traverse or bundle dependencies from node_modules.
      builder.onResolve({ filter: /./ }, args => {
        if (args.kind === "entry-point") return;
        graph.get(repoPath(args.importer))?.push(args.path);
        return { path: args.path, external: true };
      });
    } }],
  });
  return graph;
}

test("runtime dependencies preserve browser and builtin plugin ownership", async () => {
  const graph = await sourceImports();
  assert.ok(graph.get("src/plugins/builtin/client.ts")?.includes("./files/client/plugin.tsx"), "literal dynamic imports are scanned");
  assert.ok(graph.get("src/adapters/pi/extension.ts")?.includes("../../host/server/bootstrap/pi-host.ts"), "re-exports are scanned");
  assert.deepEqual(dependencyViolations(graph), []);
});

test("dependency rules permit composition and contracts but reject indirect runtime and private imports", () => {
  const graph: ImportGraph = new Map([
    ["src/host/client/app.tsx", ["../../plugins/builtin/client.ts", "../../contracts/view.ts"]],
    ["src/plugins/builtin/client.ts", ["./files/client/plugin.tsx"]],
    ["src/plugins/builtin/files/client/plugin.tsx", []],
    ["src/contracts/view.ts", []],
    ["src/host/server/transport/bridge.ts", ["../../../plugins/builtin/files/contract/manifest.ts", "../../../plugins/builtin/files/server/public.ts"]],
  ]);
  assert.deepEqual(dependencyViolations(graph), []);
  graph.set("src/contracts/view.ts", ["./forward.ts"]);
  graph.set("src/contracts/forward.ts", ["node:fs"]);
  graph.get("src/host/server/transport/bridge.ts")?.push("../../../plugins/builtin/new-plugin/server/private.ts");
  const failures = dependencyViolations(graph);
  assert.ok(failures.some(failure => failure.includes("src/contracts/forward.ts -> node:fs")));
  assert.ok(failures.some(failure => failure.includes("src/plugins/builtin/new-plugin/server/private.ts")));
});

test("transport and workbench dispatch registered contributions; the Pi entry stays thin", async () => {
  const bridge = await readFile(new URL("../src/host/server/transport/bridge.ts", import.meta.url), "utf8");
  const panel = await readFile(new URL("../src/host/client/PluginPanel.tsx", import.meta.url), "utf8");
  assert.match(bridge, /pluginRegistry\.dispatch/);
  assert.match(panel, /definition\.workbench/);
  const adapter = await readFile(new URL("../src/adapters/pi/extension.ts", import.meta.url), "utf8");
  assert.ok(adapter.split("\n").length < 15);
  assert.match(adapter, /export \{ default \}/);
});
