import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostedPluginIntegration } from "../src/host/server/plugins/hosted/integration.ts";
import { atomicJson } from "../src/host/server/plugins/hosted/storage.ts";
import { hostedId as id, integrationFixture, integrity } from "./helpers/hosted-integration-fixture.ts";

for (const updatePolicy of ["notify", "automatic", "pinned"] as const) test(`software startup migrates persisted ${updatePolicy} and updates installed disabled plugin`, async () => {
  const root = await mkdtemp(join(tmpdir(), "ori42-migration-"));
  const first = integrationFixture(), next = integrationFixture("0.2.0");
  const integration = new HostedPluginIntegration({ root, workerEntry: "unused", hostVersion: "0.1.29", ownerId: "test", resolveSession: () => null,
    fetch: (async url => String(url).endsWith(".tgz") ? new Response(new Uint8Array(next.bytes)) : Response.json({ versions: { "0.2.0": next.release } })) as typeof fetch });
  try {
    await integration.manager.installer.installArchive(id, first.bytes, integrity(first.bytes), "0.1.0");
    await mkdir(join(root, "policies"), { recursive: true });
    await atomicJson(join(root, "policies/policies.json"), { [id]: { updatePolicy, ...(updatePolicy === "pinned" ? { pinnedVersion: "0.1.0" } : {}) } });
    await integration.start();
    const card = (await integration.inventory()).plugins[0]!;
    assert.equal(card.version, "0.2.0"); assert.equal(card.enabled, false); assert.equal(card.pinnedVersion, undefined);
    assert.deepEqual(JSON.parse(await readFile(join(root, "policies/policies.json"), "utf8")), { [id]: { updatePolicy: "notify" } });
    assert.equal(JSON.parse(await readFile(join(root, "host-version.json"), "utf8")).version, "0.1.29");
  } finally { await integration.shutdown(); await rm(root, { recursive: true, force: true }); }
});

for (const kind of ["metadata_not_found", "tarball_not_found", "no_compatible_version", "registry_unreachable"] as const) test(`HTTP diagnostic ${kind} preserves installed bytes and exposes a structured card failure`, async () => {
  const root = await mkdtemp(join(tmpdir(), "ori42-errors-"));
  const first = integrationFixture(), next = integrationFixture("0.2.0");
  const integration = new HostedPluginIntegration({ root, workerEntry: "unused", hostVersion: "0.1.29", ownerId: "test", resolveSession: () => null,
    fetch: (async url => {
      if (kind === "registry_unreachable") throw new TypeError("fetch failed: offline");
      if (kind === "metadata_not_found" || String(url).endsWith(".tgz")) return new Response("not found", { status: 404 });
      return Response.json({ versions: kind === "no_compatible_version" ? {} : { "0.2.0": next.release } });
    }) as typeof fetch });
  try {
    await integration.start();
    const before = await integration.manager.installer.installArchive(id, first.bytes, integrity(first.bytes), "0.1.0");
    await assert.rejects(integration.manage({ pluginId: id, operation: "update", downloadId: crypto.randomUUID() }), { code: kind });
    const card = (await integration.inventory()).plugins[0]!;
    assert.equal(card.errorCode, kind); assert.equal(card.version, "0.1.0"); assert.equal(card.enabled, false);
    assert.equal((await integration.manager.installer.load(id, "0.1.0")).digest, before.digest);
  } finally { await integration.shutdown(); await rm(root, { recursive: true, force: true }); }
});
