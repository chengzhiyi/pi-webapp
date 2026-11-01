import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Post-build verification of the generated site. VitePress already fails the
// build on dead page links; this additionally checks every link and asset in the
// output (including #anchors) and that only reviewed user-guide pages are built.
const docs = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(docs, '.vitepress/dist');
const base = process.env.DOCS_BASE ?? '/pi-webapp/';
const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? walk(path) : [path];
});
assert(existsSync(dist), 'Build the documentation first (npm run docs:build)');

const pages = walk(dist).filter((p) => p.endsWith('.html'));
const guide = (lang) => walk(join(docs, lang)).filter((p) => p.endsWith('.md')).map((p) => relative(join(docs, lang), p)).sort();
const en = guide('en');
const zh = guide('zh');
assert.deepEqual(zh, en, 'Every English page needs a Chinese counterpart in docs/zh, and the other way round');
// English is published at the root, Chinese under /zh/.
const expected = ['404.html', ...en.map((p) => p.replace(/\.md$/, '.html')), ...zh.map((p) => `zh/${p.replace(/\.md$/, '.html')}`)].sort();
assert.deepEqual(pages.map((p) => relative(dist, p)).sort(), expected,
  'Only pages under docs/en and docs/zh may be built (no engineering, operations or archive pages)');

const decode = (text) => text.replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&#39;', "'");
const ids = new Map(pages.map((p) => [p, new Set([...readFileSync(p, 'utf8').matchAll(/\bid="([^"]+)"/g)].map((m) => decode(m[1])))]));
let links = 0;
for (const page of pages) {
  const html = readFileSync(page, 'utf8');
  for (const match of html.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
    const value = decode(match[1]);
    if (/^(?:https?:|mailto:|tel:|data:|\/\/)/.test(value)) continue;
    assert(!/^javascript:/i.test(value), 'No executable links');
    const url = new URL(value, `https://docs.invalid${base}${relative(dist, page)}`);
    assert(url.pathname.startsWith(base), `${relative(dist, page)}: link escapes the site base: ${value}`);
    let path = decodeURIComponent(url.pathname.slice(base.length));
    if (!path || path.endsWith('/')) path += 'index.html';
    // cleanUrls: /guide resolves to guide.html.
    const target = [path, `${path}.html`].map((p) => resolve(dist, p)).find((p) => existsSync(p) && statSync(p).isFile());
    assert(target?.startsWith(`${dist}/`), `${relative(dist, page)}: missing target ${value}`);
    if (url.hash && target.endsWith('.html')) {
      const id = decodeURIComponent(url.hash.slice(1));
      assert(ids.get(target)?.has(id), `${relative(dist, page)}: missing anchor ${value}`);
    }
    links++;
  }
}
console.log(`PASS: ${pages.length} HTML pages; ${links} local links, assets and anchors resolve`);
