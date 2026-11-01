# Developers

This page is for people who want to build pi-webapp from source, write a plugin, or contribute to these docs. The user guide doesn't cover internals, so this page points to where they live.

## Run from source

You need Node.js 22.19 or later.

```bash
git clone https://github.com/chengzhiyi/pi-webapp.git
cd pi-webapp
npm ci
npm run check
npm test
npm run start
```

`npm run start` builds and launches the background service. After you change extension code, run `npm run stop` and `npm run start` again; reloading the browser doesn't replace the backend. With `pi -e .`, rebuild and enter `/reload`, then `/web` in Pi. `npm run dev` stops any running service by force, rebuilds and starts, which is convenient but drops unsaved plugin edits. See [Command line](./reference/cli).

For the desktop app:

```bash
npm run desktop:prepare
npm run desktop:start
npm run desktop:package   # creates a host-native installer in desktop-release/
```

## Plugin development

Set `PI_WEBAPP_PLUGIN_DEV_ROOTS` to the folders of trusted local plugin sources. Separate several with your platform's path delimiter (`:` on macOS and Linux, `;` on Windows). The launcher loads them as Pi extensions and reloads when a plugin's built `dist/extension.js` changes. Only use folders you trust: they run with your permissions.

## Engineering documents on GitHub

These documents describe how pi-webapp is built and released. They aren't part of this site and may refer to internal work items.

- [Architecture](https://github.com/chengzhiyi/pi-webapp/blob/main/docs/architecture.md): layers, ownership and plugin lifecycle
- [Web plugins](https://github.com/chengzhiyi/pi-webapp/blob/main/docs/web-plugins.md): the plugin protocol
- [Hosted plugin runtime](https://github.com/chengzhiyi/pi-webapp/blob/main/docs/hosted-plugin-runtime.md) and [installation](https://github.com/chengzhiyi/pi-webapp/blob/main/docs/hosted-plugin-installation.md)
- [Release channels](https://github.com/chengzhiyi/pi-webapp/blob/main/docs/release-channels.md)
- [Desktop builds](https://github.com/chengzhiyi/pi-webapp/blob/main/docs/desktop.md) and [macOS test installation](https://github.com/chengzhiyi/pi-webapp/blob/main/docs/desktop-testing.md)
- [Sentry operations](https://github.com/chengzhiyi/pi-webapp/blob/main/docs/sentry.md)
- [Design decisions](https://github.com/chengzhiyi/pi-webapp/tree/main/docs/decisions)

## Work on these docs

The site is built with [VitePress](https://vitepress.dev/). The English pages are the Markdown files in `docs/en/`, published at the site root; the Chinese translation is in `docs/zh/`, published under `/zh/`. Everything else in `docs/` is engineering material and is deliberately left out of the build.

```bash
npm --prefix docs ci      # once
npm run docs:dev          # live preview
npm run docs:build        # production build; fails on dead page links
npm run docs:check        # verifies every link, asset and #anchor in the output, and that each English page has a Chinese counterpart
npm run docs:preview      # serve the production build locally
```

The preview URL ends with `/pi-webapp/`, because the site is built for a GitHub Pages project path. Set `DOCS_BASE=/` for a root-hosted build.

Guidelines for pages:

- Start with one sentence saying what the page helps with, then give the steps before the explanation.
- Check every command, option, default and path against the code or by running it. When this guide and the code disagree, the code wins and the guide gets fixed.
- Quote exact UI labels in **bold**, and say what the output looks like.
- Keep internal work-item names and design-doc numbers out of user pages.
- Link between pages so none is a dead end.
- English is the source text. When you change an English page, update its Chinese counterpart too, quoting interface labels as they appear in the Chinese interface.
- The interface labels in screenshots are English (Chinese pages use the Chinese-interface set in `docs/public/images/zh/`). Take screenshots with a stand-in model server, never with real credentials or private projects.

Changes under `docs/` are built on every pull request; the site is deployed from `main`.
