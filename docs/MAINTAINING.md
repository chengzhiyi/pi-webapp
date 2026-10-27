# Documentation maintenance / 文档维护

Phase A: independent VitePress site, user guides first. **Not publicly deployed.** Public hosting, README/npm/app entry replacement, release provenance, permissions, and npm-publish isolation remain separately authorized phase-B work. Do not publish this commit just to preview the docs: the existing main-push workflow may release the product even for documentation-only changes.

## Local build and preview

Use Node.js ≥ 22.19. Product dependencies/builds are not prerequisites:

```bash
npm --prefix docs ci
npm --prefix docs run build
npm --prefix docs run check
npm --prefix docs run preview
```

Open the loopback URL printed by VitePress, with **`/pi-webapp/`** appended. For authoring use `npm --prefix docs run dev`. Stop with Ctrl+C. Build output: `docs/.vitepress/dist`; do not open HTML with `file://` (search and ES modules require HTTP). No hostname in the config claims Pages is enabled.

The docs package and lockfile are independent; no root `build`, `prepack`, product dependency, or React/Electron runtime changes. `vitepress` is pinned to 1.6.4. Its Vite 5 dependency has reported dev-server issues; the docs-only override pins Vite **6.4.5** (supported by plugin-vue 5) and is exercised by build/preview/browser checks. Reassess/remove the override on a future compatible VitePress upgrade. Keep servers loopback-only. No third-party search/analytics is configured.

## Checks

```bash
npm --prefix docs run build
npm --prefix docs run check
# Install Chromium once if Chrome is unavailable:
npm --prefix docs exec -- playwright install chromium
npm --prefix docs run test:browser
# Or use the machine's Chrome:
PI_WEB_TEST_CHROME=true npm --prefix docs run test:browser
npm --prefix docs audit
# From the product repository root; never run npm publish for validation:
npm pack --dry-run --ignore-scripts --json
```

`check` verifies paired language pages, reviewed output pages, every local HTML link/asset, and fragment anchors under the project base. It intentionally does not network-crawl GitHub or validate behavior of model accounts. Browser tests own a bounded loopback preview child process, use no Pi backend or credentials, and cover deep-link reload, language counterpart links, Chinese/English search, keyboard behavior, and 390 px layout. No persistent/public service is started. When a Paperclip execution workspace provides runtime controls, use its managed service for interactive QA.

Inspect npm's file list: docs dependencies, guides, config, tests, cache, and built site must not enter the product package. Keep this file named `MAINTAINING.md`: npm may automatically include a nested `README.md` even with the product's explicit file allowlist. Existing explicitly allowlisted engineering Markdown remains distributed unchanged, except the plugin-entry correction. The existing generic ignore patterns already cover `node_modules`, `dist`, reports, and test-results; `.vitepress/cache` is additionally ignored.

## Content boundary and source map

`index.md` is a language chooser. Both `zh/` and `en/` contain an overview and eleven guide/reference pages. All topics have a real counterpart; adding a page requires matching locale navigation and translation. The root chooser is not a third language in the locale switcher.

| Existing path / fact source | User destination | Treatment |
| --- | --- | --- |
| README.md / README.zh-CN.md installation and launcher; bin/pi-webapp.mjs | getting-started, updates, reference | New task-oriented guides; README remains unchanged until a real published URL exists |
| README sessions/attachments; host client and contracts | sessions, conversation | Verify lifecycle/limits before changing either language |
| src/plugins/builtin; README; docs/architecture.md | workspace-tools | Scope, shared-worktree write constraints, and terminal permissions stay explicit |
| src/host/client/PiSettings.tsx, PiProviderSettings.tsx; docs/web-plugins.md | configuration | Sidebar Plugins, not Settings; package installation is not a runtime toggle |
| docs/desktop.md, docs/desktop-testing.md | desktop | Bilingual user summaries; detailed/operator source remains linked, not duplicated wholesale |
| docs/sentry.md and runtime config | security, reference | Default-off and explicit opt-in must stay visible; operator upload/triage details remain in GitHub |
| docs/architecture.md, web-plugins.md, sentry-triage.md, decisions/, spec.md | resources | Existing paths/anchors preserved, excluded from site build/search |
| Upstream Pi 0.87.1 CLI/package docs | updates | `pi update npm:pi-webapp` targets the extension; bare `pi update` updates Pi itself |

VitePress `srcExclude` lists existing non-site Markdown; `check` fails if any unreviewed HTML page slips into output. Do not copy old specs into the user navigation. Existing engineering links still work in GitHub. The local guide index is `zh/index.md` / `en/index.md`; use the preview server for website-relative links.

## Maintenance responsibilities

- The author of a visible behavior change updates both affected guides or explains why no update is needed. The owner of the touched runtime area checks the documented behavior; no new named team is invented.
- Installation, updates, privacy/data retention, desktop trust, and plugin boundaries require source-owner review, not only a green build.
- Use root-manifest version only as **development source metadata**, never as npm-latest proof. A visible development banner appears on every guide. Stable publishing must pin a verified release commit in phase B.
- No product CI/branch checks, npm publishing, Pages workflow, domain, repository permissions, or application help entry was changed in phase A. Before pushing/merging, explicitly handle docs-only product publication in phase B; mixed product/docs changes must retain product safety checks.
- Actual first-install/provider authorization, paid model calls, desktop download/Finder trust, external link availability, and Linux/Windows runtime testing require their own environment/authority. Static/browser site tests do not establish those results.
