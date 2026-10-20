// Opt-in artwork build; packaging uses the checked-in outputs and needs no browser.
import { chromium } from "playwright";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const directory = new URL("../desktop/icons/", import.meta.url);
const svg = await readFile(new URL("icon.svg", directory), "utf8");
const browser = await chromium.launch({ headless: true,
  ...(process.env.PI_WEB_TEST_CHROME === "true" ? { channel: "chrome" } : {}) });
const images = new Map();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:100vw;height:100vh}</style>${svg}`);
    // Element capture waits for a stable layout after each viewport change.
    images.set(size, await page.locator("svg").screenshot({ omitBackground: true, animations: "disabled" }));
  }
} finally { await browser.close(); }
await writeFile(new URL("icon.png", directory), images.get(1024));

// PNG-backed ICO entries are supported by all Windows versions Electron supports.
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const icoHeader = Buffer.alloc(6 + icoSizes.length * 16);
icoHeader.writeUInt16LE(1, 2);
icoHeader.writeUInt16LE(icoSizes.length, 4);
let offset = icoHeader.length;
for (const [index, size] of icoSizes.entries()) {
  const png = images.get(size);
  const at = 6 + index * 16;
  icoHeader[at] = icoHeader[at + 1] = size === 256 ? 0 : size;
  icoHeader.writeUInt16LE(1, at + 4);
  icoHeader.writeUInt16LE(32, at + 6);
  icoHeader.writeUInt32LE(png.length, at + 8);
  icoHeader.writeUInt32LE(offset, at + 12);
  offset += png.length;
}
await writeFile(new URL("icon.ico", directory), Buffer.concat([icoHeader, ...icoSizes.map(size => images.get(size))]));

// Modern ICNS stores PNG representations, including explicit Retina entries.
const entries = { icp4: 16, icp5: 32, icp6: 64, ic07: 128, ic08: 256, ic09: 512, ic10: 1024,
  ic11: 32, ic12: 64, ic13: 256, ic14: 512 };
const chunks = Object.entries(entries).map(([type, size]) => {
  const png = images.get(size);
  const header = Buffer.alloc(8);
  header.write(type);
  header.writeUInt32BE(png.length + 8, 4);
  return Buffer.concat([header, png]);
});
const icnsHeader = Buffer.alloc(8);
icnsHeader.write("icns");
icnsHeader.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4);
await writeFile(new URL("icon.icns", directory), Buffer.concat([icnsHeader, ...chunks]));
console.log(`Generated PNG, ICO and ICNS in ${fileURLToPath(directory)}`);
