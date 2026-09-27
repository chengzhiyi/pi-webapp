import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("embeds the Pi favicon in the page without a separate asset request", async () => {
  const html = await readFile(new URL("../web/src/index.html", import.meta.url), "utf8");
  const logo = await readFile(new URL("../web/src/assets/pi-logo.svg", import.meta.url));
  const encoded = html.match(/<link rel="icon" type="image\/svg\+xml" href="data:image\/svg\+xml;base64,([^"]+)" \/>/)?.[1];

  assert.ok(encoded, "the page declares an embedded SVG favicon");
  assert.deepEqual(Buffer.from(encoded, "base64"), logo);
});
