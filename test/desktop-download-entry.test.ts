import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

for (const file of ["README.md", "README.zh-CN.md"]) {
  test(`${file} exposes a direct desktop download before the cover and command-line installation`, async () => {
    const text = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    const link = /https:\/\/github\.com\/chengzhiyi\/pi-webapp\/releases\/download\/desktop-v[\w.-]+\/pi-[\w.-]+-mac-arm64\.dmg/.exec(text);
    assert.ok(link, "homepage needs a direct installer link, not just the Releases list");
    const firstImage = text.search(/!\[/);
    assert.ok(firstImage >= 0 && link.index < firstImage, "download must be above the first product image");
    assert.ok(link.index < text.indexOf("npx pi-webapp"), "do not make desktop users read CLI installation first");
    const introduction = text.slice(0, firstImage);
    assert.match(introduction, /SHA-256/);
    assert.match(introduction, /unsigned|未签名/i);
    assert.match(introduction, /Apple/);
  });
}
