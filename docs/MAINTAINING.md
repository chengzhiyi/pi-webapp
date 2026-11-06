# Maintaining the documentation site

The user guide is a [VitePress](https://vitepress.dev/) site built from `docs/en/` and deployed to GitHub Pages. Everything else in `docs/` (design notes, release and CI records) is engineering material that is not built into the site.

This file is named `MAINTAINING.md` on purpose: npm can include a nested `README.md` in the package even with an explicit `files` allowlist.

## Layout

| Path | What it is |
| --- | --- |
| `docs/en/**` | The English user guide. Published at the site root through a VitePress rewrite (`docs/en/getting-started.md` becomes `/getting-started`). |
| `docs/public/` | Static files: `logo.svg` and the screenshots in `images/` (English interface) and `images/zh/` (Chinese interface). |
| `docs/.vitepress/config.mts` | Navigation, sidebar, search, edit links, base path. Add a page here as well as creating the file. |
| `docs/.vitepress/check-site.mjs` | Post-build check of every link, asset and `#anchor`, and of the list of built pages. |
| `docs/tests/site.spec.ts` | Browser tests of the built site (navigation, search, dark mode, images, mobile width). |
| `docs/package.json`, `docs/package-lock.json` | The docs' own dependencies, independent of the product. |
| `docs/zh/**` | The Chinese translation, published under `/zh/`. See "Translations". |
| `.github/workflows/docs.yml` | Builds on every docs pull request and deploys from `main`. |

The docs package is separate on purpose: the product's `build`, `prepack`, `check` and `test` do not depend on it, and the npm package's `files` allowlist does not include `docs/en`, `docs/public` or `docs/.vitepress`. After touching `package.json`, check with `npm pack --dry-run --ignore-scripts --json`.

## Commands

From the repository root, after `npm --prefix docs ci`:

```bash
npm run docs:dev        # live preview
npm run docs:build      # production build; fails on a dead page link
npm run docs:check      # verifies links, assets, anchors and the page list in the output
npm run docs:preview    # serve the built site at /
npm --prefix docs run test:browser   # browser tests; needs a Playwright Chromium (npm --prefix docs exec -- playwright install chromium)
```

Don't open the built HTML with `file://`: search and ES modules need HTTP. Set `DOCS_BASE=/pi-webapp/` to build for the GitHub Pages project path instead of the domain root.

## Deployment

`docs.yml` runs on pull requests that touch `docs/**` (build and check only), and on pushes to `main` that touch `docs/**` (build, check, deploy). It can also be run by hand from `main`.

One-time setup, which needs repository admin rights: **Settings → Pages → Build and deployment → Source: GitHub Actions**. Until that is enabled the deploy job fails.

The site is served at <https://pi.emath.top>:

1. DNS (at the registrar for `emath.top`): `CNAME  pi  →  chengzhiyi.github.io`. With Cloudflare, keep the record "DNS only" until HTTPS is issued.
2. **Settings → Pages → Custom domain**: `pi.emath.top`, save, wait for the DNS check, then tick **Enforce HTTPS**. With Actions-based deploys the domain lives in this setting, so no `CNAME` file is needed.
3. Recommended: verify `emath.top` under the account's **Settings → Pages → Add a domain** (a TXT record) so nobody else can claim a subdomain of it.

`base` in the config is `/` to match the domain root. A build for the old project URL (`https://chengzhiyi.github.io/pi-webapp/`) needs `DOCS_BASE=/pi-webapp/`; once the custom domain is active GitHub redirects that URL to the new one, so the project path is only needed if the domain is removed.

`ci.yml` ignores pushes that only touch `docs/**` or `docs.yml`, so a documentation-only merge deploys the site without running CI or publishing the package. Mixed pushes still run everything.

## Writing rules

- One sentence at the top says what the page solves. Steps first, explanation second.
- Every command, option, default, path and port is checked against the code or by running it. If a page and the code disagree, the code wins.
- Quote UI labels exactly, in **bold**. The interface is localized; the docs use the English labels. The launcher's command-line output is Chinese only, so quote it verbatim and translate it.
- No internal work-item names, RFC numbers or branch names on user pages. Link to engineering documents on GitHub from the Developers page instead.
- Screenshots live in `docs/public/images/`. Take them with a stand-in model server and a throwaway Pi data folder (`PI_CODING_AGENT_DIR`), never with real credentials, real projects or your own skill list. Keep them under about 100 KB each.
- Give an `{#id}` to any heading you link to by anchor from another page. `docs:check` fails on a missing anchor.

## Translations

English (`docs/en/`) is the source text. The Chinese translation lives in `docs/zh/` with the same file names, published under `/zh/`; `docs:check` fails if a page exists in only one language. Chinese pages use the Chinese-interface screenshots in `docs/public/images/zh/` and quote interface labels exactly as the Chinese interface shows them (they come from the `t("中文", "English")` pairs in the source). Command output and launcher messages are Chinese in both languages. When you change an English page, change its counterpart in the same pull request. To retake the Chinese screenshots, follow "Writing rules" with the browser locale set to `zh` (`localStorage['pi-web-locale'] = 'zh'`) and Chinese prompts for the stand-in model.

## Changelog and releases

`docs/en/changelog.md` (with `docs/zh/changelog.md`) is the user-facing changelog, published at `/changelog`. It is the only list of what changed: GitHub release notes and the home page badge are taken from it.

**With each feature or fix pull request.** Add a line under `## Unreleased {#unreleased}` in both languages, in the section that fits: **Highlights** for something worth announcing (a bold lead, two or three sentences, a link to the page that explains it), **Improvements and fixes** for the rest, **For plugin developers** for plugin-API changes. Write what the user notices, not the implementation; skip refactors, CI and tests. Use relative page links (`./workspace-tools#files`), which also become absolute links in the release notes.

**Desktop build.** `npm run desktop:prepare-build` renames the Unreleased heading in both files to `## Desktop build N · pi X · YYYY-MM-DD {#build-N}`. Review the text before committing. The release workflow stops at `--check-source` if `docs/en/changelog.md` has no non-empty `{#build-N}` section, and puts that section at the top of the GitHub release notes as **What's new**, with links to the full changelog in both languages.

**Promotion to `main` without a desktop build.** When the promotion brings user-visible changes, rename Unreleased by hand to `## pi X · YYYY-MM-DD {#vX-Y-Z}` (dots become dashes in the anchor), where X is the stable version the promotion will publish.

**Every release with highlights.** Point the `release` front matter of `docs/en/index.md` and `docs/zh/index.md` at the new section. It is the badge above the home page title. Keep `text` to one short line.

Both files must have the same section anchors in the same order; `npm run test:desktop` checks it.

## Checks before merging

```bash
npm run docs:build && npm run docs:check
npm --prefix docs run test:browser
npm pack --dry-run --ignore-scripts --json   # no docs/en, docs/public or docs/.vitepress in the file list
```

For installation, update, security, privacy and desktop pages, a source-owner review is needed in addition to a green build.
