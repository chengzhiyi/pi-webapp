import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const config = require("../builder.cjs");
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function pngSize(buffer) {
  assert.deepEqual(buffer.subarray(0, 8), pngSignature);
  assert.equal(buffer.toString("ascii", 12, 16), "IHDR");
  return [buffer.readUInt32BE(16), buffer.readUInt32BE(20)];
}

test("desktop packaging explicitly selects custom icons for all three platforms", async () => {
  assert.equal(config.mac.icon, "desktop/icons/icon.icns");
  assert.equal(config.win.icon, "desktop/icons/icon.ico");
  assert.equal(config.linux.icon, "desktop/icons/icon.png");
  assert.ok(config.files.includes("icons/icon.png"), "window/development icon must survive ASAR packaging");
  const png = await readFile(new URL("../icons/icon.png", import.meta.url));
  assert.deepEqual(pngSize(png), [1024, 1024]);
  assert.equal(png[25], 6, "master PNG must retain an alpha channel");
});

test("macOS ICNS contains correctly sized standard and Retina PNG representations", async () => {
  const icon = await readFile(new URL("../icons/icon.icns", import.meta.url));
  assert.equal(icon.toString("ascii", 0, 4), "icns");
  assert.equal(icon.readUInt32BE(4), icon.length);
  const expected = new Map(Object.entries({ icp4: 16, icp5: 32, icp6: 64, ic07: 128, ic08: 256,
    ic09: 512, ic10: 1024, ic11: 32, ic12: 64, ic13: 256, ic14: 512 }));
  let offset = 8;
  while (offset < icon.length) {
    const type = icon.toString("ascii", offset, offset + 4);
    const length = icon.readUInt32BE(offset + 4);
    assert.ok(length > 8 && offset + length <= icon.length);
    assert.ok(expected.has(type), `unexpected or duplicate entry ${type}`);
    const size = expected.get(type);
    assert.deepEqual(pngSize(icon.subarray(offset + 8, offset + length)), [size, size]);
    expected.delete(type);
    offset += length;
  }
  assert.equal(offset, icon.length);
  assert.equal(expected.size, 0);
});

test("Windows ICO includes small taskbar icons and a 256px PNG", async () => {
  const icon = await readFile(new URL("../icons/icon.ico", import.meta.url));
  assert.equal(icon.readUInt16LE(0), 0);
  assert.equal(icon.readUInt16LE(2), 1);
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  assert.equal(icon.readUInt16LE(4), sizes.length);
  let next = 6 + 16 * sizes.length;
  for (const [index, size] of sizes.entries()) {
    const at = 6 + index * 16;
    assert.equal(icon[at] || 256, size);
    assert.equal(icon[at + 1] || 256, size);
    assert.equal(icon.readUInt16LE(at + 6), 32);
    const length = icon.readUInt32LE(at + 8);
    assert.equal(icon.readUInt32LE(at + 12), next);
    assert.deepEqual(pngSize(icon.subarray(next, next + length)), [size, size]);
    next += length;
  }
  assert.equal(next, icon.length);
});
