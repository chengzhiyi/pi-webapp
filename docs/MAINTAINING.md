# Maintaining the documentation site

The user guide is a [VitePress](https://vitepress.dev/) site built from `docs/en/` and deployed to GitHub Pages. Everything else in `docs/` (design notes, release and CI records, the older `zh/` pages) is engineering material that is not built into the site.

This file is named `MAINTAINING.md` on purpose: npm can include a nested `README.md` in the package even with an explicit `files` allowlist.

## Layout

| Path | What it is |
| --- | --- |
| `docs/en/**` | The user guide. Published at the site root through a VitePress rewrite (`docs/en/getting-started.md` becomes `/getting-started`). |
| `docs/public/` | Static files: `logo.svg` and the screenshots in `images/`. |
| `docs/.vitepress/config.mts` | Navigation, sidebar, search, edit links, base path. Add a page here as well as creating the file. |
| `docs/.vitepress/check-site.mjs` | Post-build check of every link, asset and `#anchor`, and of the list of built pages. |
| `docs/tests/site.spec.ts` | Browser tests of the built site (navigation, search, dark mode, images, mobile width). |
| `docs/package.json`, `docs/package-lock.json` | The docs' own dependencies, independent of the product. |
| `docs/zh/**` | Older Chinese pages, **excluded from the build**. See "Translations". |
| `.github/workflows/docs.yml` | Builds on every docs pull request and deploys from `main`. |

The docs package is separate on purpose: the product's `build`, `prepack`, `check` and `test` do not depend on it, and the npm package's `files` allowlist does not include `docs/en`, `docs/public` or `docs/.vitepress`. After touching `package.json`, check with `npm pack --dry-run --ignore-scripts --json`.

## Commands

From the repository root, after `npm --prefix docs ci`:

```bash
npm run docs:dev        # live preview
npm run docs:build      # production build; fails on a dead page link
npm run docs:check      # verifies links, assets, anchors and the page list in the output
npm run docs:preview    # serve the built site (URL ends with /pi-webapp/)
npm --prefix docs run test:browser   # browser tests; needs a Playwright Chromium (npm --prefix docs exec -- playwright install chromium)
```

Don't open the built HTML with `file://`: search and ES modules need HTTP. Set `DOCS_BASE=/` to build for a root-hosted site instead of `/pi-webapp/`.

## Deployment

`docs.yml` runs on pull requests that touch `docs/**` (build and check only), and on pushes to `main` that touch `docs/**` (build, check, deploy). It can also be run by hand from `main`.

One-time setup, which needs repository admin rights: **Settings → Pages → Build and deployment → Source: GitHub Actions**. Until that is enabled the deploy job fails. The expected address is `https://chengzhiyi.github.io/pi-webapp/`, and `base` in the config must match the path.

Docs-only pushes to `main` also start `ci.yml`, whose publish job runs on every push to `main`. Look at that before merging documentation alone.

## Writing rules

- One sentence at the top says what the page solves. Steps first, explanation second.
- Every command, option, default, path and port is checked against the code or by running it. If a page and the code disagree, the code wins.
- Quote UI labels exactly, in **bold**. The interface is localized; the docs use the English labels. The launcher's command-line output is Chinese only, so quote it verbatim and translate it.
- No internal work-item names, RFC numbers or branch names on user pages. Link to engineering documents on GitHub from the Developers page instead.
- Screenshots live in `docs/public/images/`. Take them with a stand-in model server and a throwaway Pi data folder (`PI_CODING_AGENT_DIR`), never with real credentials, real projects or your own skill list. Keep them under about 100 KB each.
- Give an `{#id}` to any heading you link to by anchor from another page. `docs:check` fails on a missing anchor.

## Translations

The English guide is the source of truth. A translation goes under `docs/zh/` with a VitePress `locales` entry, and replaces the current `zh/` pages: those predate this guide and are no longer in step with it, which is why `zh/**` is in `srcExclude`. Translate from the stable English text; don't ship a partial translation.

## Checks before merging

```bash
npm run docs:build && npm run docs:check
npm --prefix docs run test:browser
npm pack --dry-run --ignore-scripts --json   # no docs/en, docs/public or docs/.vitepress in the file list
```

For installation, update, security, privacy and desktop pages, a source-owner review is needed in addition to a green build.
