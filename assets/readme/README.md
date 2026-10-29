# README visual assets

The UI screenshots illustrate the real pi-webapp interface using **seeded demo conversations** and disposable workspaces. They are not a recording of a live model run. No provider authentication, user sessions, or private repositories are used.

| Asset | Contents |
| --- | --- |
| `workbench.png` | Full workbench: project navigation, conversation, and read-only TypeScript preview. |
| `git-review.png` | Git tool panel: staged regression tests and the actual `>` → `>=` working-tree diff. |
| `terminal.png` | Terminal tool panel: actual Node test execution in the disposable project, with two passing tests. |
| `excalidraw.png` | Actual optional Excalidraw plugin tool card, with a seeded hand-drawn workflow and native Edit entry. Captured at 2× density, not a fabricated UI or live model transcript. |
| `architecture-zh.png` | User-supplied hand-drawn architecture image, embedded directly in the Chinese README. Preserve this original when regenerating SVGs. |
| `architecture-en.png` | High-resolution English architecture image, embedded directly in the English README. |
| `architecture-en.svg` / `architecture-zh.svg` | Editable vector counterparts using the same layered composition; the Chinese PNG retains the supplied hand-drawn styling. No remote fonts, scripts, or embedded private data. |

## Regenerate screenshots

From a source checkout with Node.js 22.19+ and dependencies installed:

```bash
npm run build
npx playwright install chromium  # Only if the browser is not installed yet
node --experimental-strip-types scripts/capture-readme.ts
```

The capture script starts a loopback bridge only for the bounded capture run and closes it afterward. It creates a temporary Git repository and shell, seeds example messages without calling a model, checks code and diff rendering, runs the demo tests in a real PTY, and checks for browser errors before cleanup. The Git repository, plugin settings, and shell profile are temporary; your normal Pi service and settings are not changed. The helper currently uses a POSIX shell and Git; run it on macOS/Linux.

Screenshots are captured at a 1440 × 760 viewport and 1.5× pixel density. The hero shows the full page; the Git and terminal images crop to the tool panel so their details remain legible side by side. Do not fabricate UI controls or test output in post-processing. Interface copy is English in both READMEs; surrounding captions are localized.

## Regenerate the Excalidraw showcase

Build the host, then provide an independently built compatible plugin archive:

```bash
npm run build
CAPTURE_README_EXCALIDRAW=1 HOSTED_EXCALIDRAW_TGZ=/absolute/path/plugin.tgz \
  npx playwright test test/browser/readme-excalidraw.spec.ts --workers=1
```

Unset inherited `PI_WEBAPP_RESTART_PORT`, `PI_WEBAPP_RESTART_TOKEN`, and `PI_WEBAPP_LAUNCHER_NONCE` when capturing from inside a running Pi Web service, so the temporary bridge uses its own port and token. The opt-in capture uses the actual host, plugin worker, preview, and native editor with deterministic local registry/model fixtures; it makes no external requests. It saves only the tool-card crop, verifies the editor opens, and cleans up its temporary workspace. A local verification archive is not evidence of an npm release. Both READMEs share the English demo image with localized surrounding text.

## Maintain the diagrams

The architecture diagrams use the chat-authored three-layer composition: shared UI, local Node host, and execution capabilities, with only three vertical connectors. The side rail shows contracts, optional hosted extensions, and diagnostics. Excalidraw is an optional plugin, not a builtin.

Regenerate both localized SVGs from their shared layout and copy:

```bash
node scripts/generate-readme-architecture.mjs
```

READMEs embed PNGs for image-renderer compatibility; keep the workbench, Git, and terminal screenshots visible as well. The Chinese PNG is the user's supplied original, not a generated SVG export. To refresh the English PNG, render `architecture-en.svg` at 2× pixel density (2800 × 2240) with a browser screenshot. Verify all five embedded images load in each README.

Edit the generator rather than the generated SVGs. Keep both languages, dimensions, and palette in sync; check responsibilities against the current source and `docs/architecture.md`. The diagrams include accessible titles/descriptions and use only local text and vector shapes. Validate XML and browser rendering, including text bounds, after regeneration. Same-layer placement does not imply sequential calls; process boundaries do not imply security sandboxes.

The package's `files` list includes this directory so the README images remain available in npm packages, not only on GitHub. Keep the existing `assets/cover-webapp.png` separate: it is also used as the Pi package catalog cover.
