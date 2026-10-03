import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-ignore Build helper is intentionally JavaScript, outside the runtime bundle.
import { prepareSourceMaps } from "../scripts/build-config.mjs";

test("private source maps match shipped debug IDs and mismatches block archiving", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-sentry-maps-"));
  const id = "12345678-1234-1234-1234-123456789abc";
  try {
    await writeFile(join(directory, "app.js"), `/* sentry-dbid-${id} */`);
    await writeFile(join(directory, "app.js.map"), JSON.stringify({ version: 3, sources: ["main.ts"], mappings: "" }));
    await assert.rejects(prepareSourceMaps(directory), /Missing Sentry Debug ID/);
    await prepareSourceMaps(directory, true);
    const map = JSON.parse(await readFile(join(directory, "app.js.map"), "utf8"));
    assert.equal(map.debug_id, id);
    assert.equal(map.debugId, id);
    await prepareSourceMaps(directory);
    await writeFile(join(directory, "app.js.map"), JSON.stringify({ ...map, debug_id: "incorrect" }));
    await assert.rejects(prepareSourceMaps(directory, true), /Invalid Sentry Debug ID/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
