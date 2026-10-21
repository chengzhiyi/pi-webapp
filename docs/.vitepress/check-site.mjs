import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const docs = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(docs, '.vitepress/dist');
const base = '/pi-webapp/';
const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? walk(path) : [path];
});
assert(existsSync(dist), 'Build the documentation first');
const pages = walk(dist).filter((p) => p.endsWith('.html'));
const zh = readdirSync(join(docs, 'zh')).filter((p) => p.endsWith('.md')).sort();
const en = readdirSync(join(docs, 'en')).filter((p) => p.endsWith('.md')).sort();
assert.deepEqual(zh, en, 'Every guide needs a real counterpart in both languages');
const expected = ['index.html', '404.html', ...['zh', 'en'].flatMap((lang) => zh.map((p) => `${lang}/${p.replace(/\.md$/, '.html')}`))].sort();
assert.deepEqual(pages.map((p) => relative(dist, p)).sort(), expected,
  'Only reviewed user pages may be built (no engineering/operations/archive pages)');
const decode = (text) => text.replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&#39;', "'");
const ids = new Map(pages.map((p) => [p, new Set([...readFileSync(p, 'utf8').matchAll(/\bid="([^"]+)"/g)].map((m) => decode(m[1])))]));
let links = 0;
for (const page of pages) {
  const html = readFileSync(page, 'utf8');
  if (/\/(zh|en)\//.test(page)) assert(html.includes('docs-version'), `${page}: missing development/version banner`);
  for (const match of html.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
    const value = decode(match[1]);
    if (/^(?:https?:|mailto:|tel:|data:|\/\/)/.test(value)) continue;
    assert(!/^javascript:/i.test(value), 'No executable links');
    const url = new URL(value, `https://docs.invalid${base}${relative(dist, page)}`);
    assert(url.pathname.startsWith(base), `${page}: link escapes project base: ${value}`);
    let path = decodeURIComponent(url.pathname.slice(base.length));
    if (!path || path.endsWith('/')) path += 'index.html';
    const target = resolve(dist, path);
    assert(target.startsWith(`${dist}/`), `Path escapes dist: ${value}`);
    assert(existsSync(target), `${relative(dist, page)}: missing target ${value}`);
    if (url.hash && target.endsWith('.html')) {
      const id = decodeURIComponent(url.hash.slice(1));
      assert(ids.get(target)?.has(id), `${relative(dist, page)}: missing anchor ${value}`);
    }
    links++;
  }
}
console.log(`PASS: ${pages.length} HTML pages; ${zh.length} paired guides per language; ${links} local links/assets/anchors; reviewed-page boundary`);
