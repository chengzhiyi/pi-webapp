import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
// @ts-ignore The release helper is JavaScript and intentionally outside the runtime bundle.
import { verifyPackageArtifacts, verifyResolvedEvent, releaseProbeLocation } from "../scripts/sentry-release.mjs";

const nodeId = "12345678-1234-1234-1234-123456789abc";
const browserId = "abcdef01-2345-6789-abcd-0123456789ab";
const expected = { release: "pi-webapp@0.1.9+release-test", buildId: "release-test", nodeDebugIds: [nodeId], browserDebugIds: [browserId] };
const code = (id: string) => `const release=${JSON.stringify(expected.release)};const buildId=${JSON.stringify(expected.buildId)};/* sentry-dbid-${id} */`;
const map = (id: string) => JSON.stringify({ version: 3, sources: ["extension/telemetry.ts"], mappings: "AAAA", debug_id: id, debugId: id });
async function put(root: string, path: string, content: string) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-web-release-"));
  const packageRoot = join(root, "package");
  const archiveRoot = join(root, "archive");
  await put(archiveRoot, "build-info.json", JSON.stringify({ release: expected.release, buildId: expected.buildId }));
  for (const [archivePath, packagePath, id] of [["node/extension.js", "dist/extension.js", nodeId], ["browser/assets/index.js", "web/dist/assets/index.js", browserId]]) {
    await put(archiveRoot, archivePath!, code(id!));
    await put(archiveRoot, `${archivePath}.map`, map(id!));
    await put(packageRoot, packagePath!, code(id!));
  }
  await put(archiveRoot, "browser/index.html", "<html>verification fixture</html>");
  await put(archiveRoot, "browser/assets/style.css", "body { color: red; }");
  await cp(join(archiveRoot, "browser/index.html"), join(packageRoot, "web/dist/index.html"));
  await cp(join(archiveRoot, "browser/assets/style.css"), join(packageRoot, "web/dist/assets/style.css"));
  return { root, packageRoot, archiveRoot };
}

test("matching npm artifacts return the exact uploaded release and both Debug ID sets", async () => {
  const f = await fixture();
  try { assert.deepEqual(await verifyPackageArtifacts(f.packageRoot, f.archiveRoot), expected); }
  finally { await rm(f.root, { recursive: true, force: true }); }
});

test("any missing, added or altered public asset blocks package verification", async () => {
  for (const change of ["missing", "added", "changed"]) {
    const f = await fixture();
    try {
      if (change === "missing") await rm(join(f.packageRoot, "web/dist/assets/style.css"));
      if (change === "added") await put(f.packageRoot, "dist/unuploaded.js", "unuploaded code");
      if (change === "changed") await put(f.packageRoot, "web/dist/index.html", "unexpected rebuild");
      await assert.rejects(verifyPackageArtifacts(f.packageRoot, f.archiveRoot));
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }
});

test("a matching JS file still fails when its archived map uses another Debug ID", async () => {
  const f = await fixture();
  try {
    await put(f.archiveRoot, "node/extension.js.map", map(browserId));
    await assert.rejects(verifyPackageArtifacts(f.packageRoot, f.archiveRoot));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("contradictory map debug_id and debugId are rejected", async () => {
  const f = await fixture();
  try {
    await put(f.archiveRoot, "browser/assets/index.js.map", JSON.stringify({ version: 3, sources: [], mappings: "", debug_id: browserId, debugId: nodeId }));
    await assert.rejects(verifyPackageArtifacts(f.packageRoot, f.archiveRoot));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("a missing archived source map blocks release verification", async () => {
  const f = await fixture();
  try {
    await rm(join(f.archiveRoot, "browser/assets/index.js.map"));
    await assert.rejects(verifyPackageArtifacts(f.packageRoot, f.archiveRoot));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("private maps and private archive directories must never appear anywhere in the npm package", async () => {
  for (const path of ["dist/extension.js.map", "web/dist/assets/index.js.map", "bin/private.map", ".sentry-artifacts/private.txt"]) {
    const f = await fixture();
    try {
      await put(f.packageRoot, path, "private source contents");
      await assert.rejects(verifyPackageArtifacts(f.packageRoot, f.archiveRoot));
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }
});

test("both sides require JavaScript containing a matching release and build identity", async () => {
  for (const side of ["node", "browser"]) {
    for (const change of ["missing-js", "missing-identity", "wrong-release", "wrong-build"]) {
      const f = await fixture();
      try {
        const archivePath = side === "node" ? "node/extension.js" : "browser/assets/index.js";
        const packagePath = side === "node" ? "dist/extension.js" : "web/dist/assets/index.js";
        if (change === "missing-js") {
          await rm(join(f.archiveRoot, archivePath));
          await rm(join(f.archiveRoot, `${archivePath}.map`));
          await rm(join(f.packageRoot, packagePath));
        } else {
          let changed = code(side === "node" ? nodeId : browserId);
          if (change === "missing-identity") changed = `/* sentry-dbid-${side === "node" ? nodeId : browserId} */`;
          if (change === "wrong-release") changed = changed.replace(expected.release, "pi-webapp@wrong-version");
          if (change === "wrong-build") changed = changed.replace('buildId="release-test"', 'buildId="wrong-build"');
          await put(f.archiveRoot, archivePath, changed);
          await put(f.packageRoot, packagePath, changed);
        }
        await assert.rejects(verifyPackageArtifacts(f.packageRoot, f.archiveRoot), `${side}: ${change}`);
      } finally { await rm(f.root, { recursive: true, force: true }); }
    }
  }
});

function resolvedEvent(side: "node" | "browser") {
  const id = side === "node" ? nodeId : browserId;
  const original = side === "node" ? "app:///dist/extension.js" : "app:///assets/index.js";
  const source = side === "node" ? "app:///extension/telemetry.ts" : "app:///web/src/telemetry.tsx";
  return {
    release: expected.release, dist: expected.buildId, environment: "sentry-verification", tags: { side },
    debug_meta: { images: [{ type: "sourcemap", code_file: original, debug_id: id }] },
    exception: { values: [{ type: "Error", value: "Synthetic release verification", raw_stacktrace: { frames: [{ filename: original, lineno: 1, colno: 10 }] }, stacktrace: { frames: [{ filename: source, lineno: 12, colno: 3, in_app: true }] } }] },
  };
}

test("release verification accepts a correctly mapped application frame for each side", () => {
  for (const side of ["node", "browser"] as const) assert.doesNotThrow(() => verifyResolvedEvent(resolvedEvent(side), expected, side));
});

test("release, build, environment, side and Debug ID mismatches each reject an event", () => {
  for (const field of ["release", "dist", "environment", "side", "debug_id"]) {
    const event = resolvedEvent("node");
    if (field === "release") event.release = "pi-webapp@old-version";
    if (field === "dist") event.dist = "old-build";
    if (field === "environment") event.environment = "production";
    if (field === "side") event.tags.side = "browser";
    if (field === "debug_id") event.debug_meta.images[0]!.debug_id = browserId;
    assert.throws(() => verifyResolvedEvent(event, expected, "node"), field);
  }
});

test("unmapped application frames and missing source line numbers fail verification", () => {
  for (const change of ["unmapped", "missing-line"]) {
    const event = resolvedEvent("node");
    if (change === "unmapped") event.exception.values[0]!.stacktrace.frames[0]!.filename = "app:///dist/extension.js";
    else event.exception.values[0]!.stacktrace.frames[0]!.lineno = 0;
    assert.throws(() => verifyResolvedEvent(event, expected, "node"));
  }
});

test("mapped dependencies cannot satisfy the application-source-map requirement", () => {
  const event = resolvedEvent("node");
  event.exception.values[0]!.raw_stacktrace.frames[0]!.filename = "app:///dist/agent.js";
  assert.throws(() => verifyResolvedEvent(event, expected, "node"));
});

test("an unmapped dependency does not invalidate a correctly resolved application frame", () => {
  const event = resolvedEvent("node");
  event.exception.values[0]!.raw_stacktrace.frames.unshift({ filename: "app:///dist/agent.js", lineno: 1, colno: 1 });
  event.exception.values[0]!.stacktrace.frames.unshift({ filename: "app:///dist/agent.js", lineno: 1, colno: 1, in_app: true });
  assert.doesNotThrow(() => verifyResolvedEvent(event, expected, "node"));
});

test("real Sentry JSON tag pairs are accepted in addition to SDK tag objects", () => {
  const event = { ...resolvedEvent("node"), tags: [["side", "node"], ["buildId", expected.buildId]] };
  assert.doesNotThrow(() => verifyResolvedEvent(event, expected, "node"));
});

test("missing JS Debug ID markers block otherwise identical package artifacts", async () => {
  const f = await fixture();
  try {
    const contents = `const release=${JSON.stringify(expected.release)};const buildId=${JSON.stringify(expected.buildId)};`;
    await put(f.packageRoot, "dist/extension.js", contents);
    await put(f.archiveRoot, "node/extension.js", contents);
    await assert.rejects(verifyPackageArtifacts(f.packageRoot, f.archiveRoot));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("the live verifier requires the exact archived probe source file and line", () => {
  const location = releaseProbeLocation({ sources: ["../extension/sentry-verification.ts"], sourcesContent: ['import stuff;\nconst error = new Error("Sentry Node release verification");'] }, "node");
  assert.deepEqual(location, { filename: "extension/sentry-verification.ts", lineno: 2 });
  const event = resolvedEvent("node");
  assert.throws(() => verifyResolvedEvent(event, expected, "node", location));
  event.exception.values[0]!.stacktrace.frames[0]!.filename = "app:///extension/sentry-verification.ts";
  event.exception.values[0]!.stacktrace.frames[0]!.lineno = 3;
  assert.throws(() => verifyResolvedEvent(event, expected, "node", location));
  event.exception.values[0]!.stacktrace.frames[0]!.lineno = 2;
  assert.doesNotThrow(() => verifyResolvedEvent(event, expected, "node", location));
  assert.throws(() => releaseProbeLocation({ sources: [], sourcesContent: [] }, "browser"));
});

test("browser maps normalize owned sources before upload without changing Debug IDs", async () => {
  // @ts-ignore Build-only JavaScript helper.
  const { prepareSourceMaps, root } = await import("../scripts/build-config.mjs");
  const { readFile } = await import("node:fs/promises");
  await mkdir(join(root, ".ci"), { recursive: true });
  const directory = await mkdtemp(join(root, ".ci/source-map-test-"));
  try {
    await put(directory, "assets/app.js", code(browserId));
    await put(directory, "assets/app.js.map", JSON.stringify({ version: 3, sources: ["../../../web/src/telemetry.ts", "../../../shared/telemetry.ts", "../../../node_modules/third-party/index.js"], sourcesContent: ['new Error("Sentry browser release verification")', "", ""], mappings: "AAAA", debug_id: browserId, debugId: browserId }));
    await prepareSourceMaps(directory, true);
    const normalized = JSON.parse(await readFile(join(directory, "assets/app.js.map"), "utf8"));
    assert.equal(normalized.sources[0], "app:///web/src/telemetry.ts");
    assert.equal(normalized.sources[1], "app:///shared/telemetry.ts");
    assert.equal(normalized.debug_id, browserId);
    assert.deepEqual(releaseProbeLocation(normalized, "browser"), { filename: "web/src/telemetry.ts", lineno: 1 });
    await prepareSourceMaps(directory);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Node upload mode stamps the on-disk map before Sentry uploads its temporary copy", async () => {
  const { build } = await import("esbuild");
  const { sentryEsbuildPlugin } = await import("@sentry/esbuild-plugin");
  // @ts-ignore Build-only JavaScript helper.
  const { nodeSourceMapPlugin, prepareSourceMaps } = await import("../scripts/build-config.mjs");
  const { readFile } = await import("node:fs/promises");
  const directory = await mkdtemp(join(tmpdir(), "pi-web-node-map-"));
  try {
    await put(directory, "entry.js", "console.log(new Error('synthetic build fixture'));");
    await build({ entryPoints: [join(directory, "entry.js")], outfile: join(directory, "out/extension.js"), bundle: true, sourcemap: "external", plugins: [
      nodeSourceMapPlugin(join(directory, "out")),
      sentryEsbuildPlugin({ telemetry: false, silent: true, release: { inject: false, create: false, finalize: false }, sourcemaps: { assets: [] } }),
    ] });
    // Empty assets prevent network uploads, while exercising the upload-mode
    // hook that leaves the original map unstamped without our preceding hook.
    await prepareSourceMaps(join(directory, "out"));
    const contents = JSON.parse(await readFile(join(directory, "out/extension.js.map"), "utf8"));
    assert.match(contents.debug_id, /^[a-f0-9-]{36}$/i);
    assert.equal(contents.debugId, contents.debug_id);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
