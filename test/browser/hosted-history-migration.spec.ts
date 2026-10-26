import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hostedParity } from "../helpers/hosted-parity.ts";
import { legacyDraft, legacyFolder, writeLegacyCheckpoint } from "../helpers/legacy-checkpoint.ts";

test("ORI-39 A24: actual old cards/checkpoint/localStorage migrate once; missing history stays unavailable", async ({ page }, info) => {
  test.skip(!process.env.HOSTED_EXCALIDRAW_TGZ, "Explicit archive required"); test.setTimeout(100_000);
  let original!: Buffer, checkpoint!: string, backupKey!: string, unavailableKey!: string, backup: any;
  const h = await hostedParity(page, { seed: async ({ root, retained, sessionId }) => {
    const scene = { ...legacyDraft.scene, elements: [{ id: "legacy-hand", type: "rectangle", x: 91, y: 37, width: 200, height: 100, groupIds: ["旧分组"] }] };
    const nativeBytes = Buffer.from(JSON.stringify(scene) + "\n"); await writeFile(join(root, "旧图.excalidraw"), nativeBytes);
    const draft = { ...legacyDraft, scene, revision: 7, savedRevision: 7, path: "旧图.excalidraw", diskHash: createHash("sha256").update(nativeBytes).digest("hex") };
    await writeLegacyCheckpoint(join(root, "legacy"), root, sessionId, draft);
    checkpoint = join(legacyFolder(join(root, "legacy"), root, sessionId), `${draft.id}.json`); original = await readFile(checkpoint);
    backup = { ...scene, elements: [{ ...scene.elements[0], x: 777 }] };
    backupKey = `pi-diagram:${sessionId}:${draft.id}`; unavailableKey = `pi-diagram:${sessionId}:lost-history`;
    await page.addInitScript(({ backupKey, unavailableKey, backup }) => { if (!localStorage.getItem(backupKey)) localStorage.setItem(backupKey, JSON.stringify(backup)); localStorage.setItem(unavailableKey, JSON.stringify(backup)); }, { backupKey, unavailableKey, backup });
    retained.sessionManager.appendMessage({ role: "user", content: "Historical drawing cards", timestamp: Date.now() });
    retained.sessionManager.appendMessage({ role: "assistant", api: "openai-responses", provider: "openai", model: "historical", timestamp: Date.now(), stopReason: "toolUse", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, content: [
      { type: "toolCall", id: "old-saved", name: "excalidraw_create_view", arguments: { title: "旧图稿", elements: "[{\"type\":\"rectangle\",\"id\":\"DO-NOT-RECONSTRUCT\",\"x\":9999,\"y\":0,\"width\":20,\"height\":20}]" } },
      { type: "toolCall", id: "old-lost", name: "excalidraw_create_view", arguments: { title: "Missing historical drawing", elements: "[]" } },
    ] });
    for (const [toolCallId, id] of [["old-saved", draft.id], ["old-lost", "lost-history"]]) retained.sessionManager.appendMessage({ role: "toolResult", toolCallId, toolName: "excalidraw_create_view", content: [{ type: "text", text: JSON.stringify({ id, title: id }) }], details: { id }, isError: false, timestamp: Date.now() });
  } });
  try {
    await page.goto(h.bridge.url);
    const cards = page.frameLocator('iframe[title="Excalidraw tool"]');
    await expect(cards.first().getByRole("img")).toBeVisible();
    await expect(cards.last().getByText("No content is available for this historical drawing.", { exact: true })).toBeVisible();
    expect((await h.rawAction("get", { id: "lost-history" })).status).toBe(404);
    expect((await h.action("list")).map((d: any) => d.id)).toEqual([legacyDraft.id]);
    const migrated = await h.action("get", { id: legacyDraft.id });
    expect(migrated.revision).toBe(7); expect(migrated.scene.elements[0].x).toBe(91); expect(migrated.savedRevision).toBe(7);
    const editor = await h.open(); await expect(editor.getByText("Unsaved local backup found", { exact: false })).toBeVisible();
    // No automatic Restore, and never reconstruct from historical tool arguments.
    expect((await h.action("get", { id: legacyDraft.id })).scene.elements[0].x).toBe(91);
    await editor.getByRole("button", { name: "Restore", exact: true }).click();
    await expect.poll(async () => (await h.action("get", { id: legacyDraft.id })).scene.elements[0].x).toBe(777);
    const restored = await h.action("get", { id: legacyDraft.id }); expect(restored.revision).toBeGreaterThan(7);
    const nativeBefore = await readFile(join(h.root, "旧图.excalidraw"));
    // Mutate the old source after import: a new generation must keep authoritative hosted
    // data rather than importing the historical checkpoint a second time.
    const old = JSON.parse(original.toString()); old.draft.scene.elements[0].x = -999;
    await writeFile(checkpoint, JSON.stringify(old)); const sourceAfter = await readFile(checkpoint);
    h.upgrade(); await h.manage("update", { reopenEditors: true });
    await expect.poll(async () => (await h.action("get", { id: legacyDraft.id })).scene.elements[0].x).toBe(777);
    expect(await readFile(checkpoint)).toEqual(sourceAfter); expect(await readFile(join(h.root, "旧图.excalidraw"))).toEqual(nativeBefore);
    expect((await h.action("list")).map((d: any) => d.id)).toEqual([legacyDraft.id]);
    expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), unavailableKey)).toEqual(backup);
    expect((await h.rawAction("get", { id: "lost-history" })).status).toBe(404);
    await cards.last().getByRole("button", { name: "Recovery options", exact: true }).click();
    const recovery = page.frameLocator('iframe[title="Excalidraw editor"]').last();
    await expect(recovery.getByText("No reliable latest content is available", { exact: false })).toBeVisible();
    expect((await h.action("list")).map((d: any) => d.id)).toEqual([legacyDraft.id]);
    const [download] = await Promise.all([page.waitForEvent("download"), recovery.getByRole("button", { name: "Download local backup", exact: true }).click()]);
    expect(JSON.parse(await readFile((await download.path())!, "utf8"))).toEqual(backup);
    await recovery.getByRole("button", { name: "Restore backup as new drawing", exact: true }).click();
    await expect(recovery.locator("canvas.interactive")).toBeVisible();
    const recoveredId = (await h.action("list")).find((d: any) => d.id !== legacyDraft.id).id;
    expect(recoveredId).not.toBe("lost-history");
    expect((await h.action("get", { id: recoveredId })).scene.elements[0].x).toBe(777);
    expect((await h.rawAction("get", { id: "lost-history" })).status).toBe(404);
    expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), unavailableKey)).toEqual(backup);
    expect(h.errors).toEqual([]); expect(h.external).toEqual([]);
    await info.attach("migration-evidence", { body: JSON.stringify({ migrated, restored, original: JSON.parse(original.toString()), oldSourceAfterImport: old, unavailableBackup: backup }), contentType: "application/json" });
  } finally { await h.close(); }
});
