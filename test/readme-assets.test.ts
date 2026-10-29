import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfm } from "micromark-extension-gfm";
import { gfmFromMarkdown } from "mdast-util-gfm";
import type { Root, RootContent } from "mdast";

function images(node: Root | RootContent): Array<{ url: string; alt: string | null | undefined }> {
  return [
    ...(node.type === "image" ? [{ url: node.url, alt: node.alt }] : []),
    ...("children" in node ? node.children.flatMap(child => images(child as RootContent)) : []),
  ];
}

test("both READMEs have accessible, packaged product images and localized diagrams", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(pkg.files.includes("assets/readme"), "npm must ship the README visual directory");
  for (const [file, locale] of [["README.md", "en"], ["README.zh-CN.md", "zh"]]) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    const tree = fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
    const visual = images(tree);
    assert.deepEqual(visual.map(image => image.url), [
      "assets/readme/workbench.png", "assets/readme/git-review.png", "assets/readme/terminal.png",
      "assets/readme/excalidraw.png", `assets/readme/architecture-${locale}.png`,
    ]);
    for (const image of visual) {
      assert.ok(image.alt && image.alt.length > 20, `${file}: descriptive alt text for ${image.url}`);
      assert.ok((await readFile(new URL(`../${image.url}`, import.meta.url))).length > 0);
    }
    assert.match(source, locale === "en" ? /seeded demo data/ : /演示数据/);
    assert.doesNotMatch(source, /sentry|DSN/i);
  }
});

test("screenshots are high-resolution PNGs and diagrams have no external dependencies", async () => {
  for (const [name, width, height] of [
    ["workbench", 2160, 1140], ["git-review", 972, 1140], ["terminal", 972, 1140],
    ["excalidraw", 1488, 722], ["architecture-en", 2800, 2240], ["architecture-zh", 2036, 1642],
  ] as const) {
    const png = await readFile(new URL(`../assets/readme/${name}.png`, import.meta.url));
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(png.readUInt32BE(16), width, `${name}: retain the original capture width`);
    assert.equal(png.readUInt32BE(20), height, `${name}: retain the original capture height`);
    assert.ok(png.length < 1024 * 1024, "keep each image below 1 MB");
  }
  for (const locale of ["en", "zh"]) {
    const svg = await readFile(new URL(`../assets/readme/architecture-${locale}.svg`, import.meta.url), "utf8");
    assert.match(svg, /viewBox="0 0 1400 1120"/);
    assert.match(svg, /<title id="title">/);
    assert.match(svg, /<desc id="desc">/);
    assert.doesNotMatch(svg, /<script|<foreignObject|<image|\bhref=|@import|<link/i);
  }
});
