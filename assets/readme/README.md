# README visual assets

These images illustrate the real pi-webapp interface using a **seeded demo conversation** and a disposable checkout project. They are not a recording of a live model run. No provider authentication, user sessions, or private repositories are used.

| Asset | Contents |
| --- | --- |
| `workbench.png` | Full workbench: project navigation, conversation, and read-only TypeScript preview. |
| `git-review.png` | Git tool panel: staged regression tests and the actual `>` → `>=` working-tree diff. |
| `terminal.png` | Terminal tool panel: actual Node test execution in the disposable project, with two passing tests. |
| `architecture-en.svg` / `architecture-zh.svg` | Editable, self-contained architecture diagrams. Text, shapes, and connectors only; no remote fonts, scripts, or embedded private data. |

## Regenerate screenshots

From a source checkout with Node.js 22.19+ and dependencies installed:

```bash
npm run build
npx playwright install chromium  # Only if the browser is not installed yet
node --experimental-strip-types scripts/capture-readme.ts
```

The capture script starts a loopback bridge only for the bounded capture run and closes it afterward. It creates a temporary Git repository and shell, seeds example messages without calling a model, checks code and diff rendering, runs the demo tests in a real PTY, and checks for browser errors before cleanup. The Git repository, plugin settings, and shell profile are temporary; your normal Pi service and settings are not changed. The helper currently uses a POSIX shell and Git; run it on macOS/Linux.

Screenshots are captured at a 1440 × 760 viewport and 1.5× pixel density. The hero shows the full page; the Git and terminal images crop to the tool panel so their details remain legible side by side. Do not fabricate UI controls or test output in post-processing. Interface copy is English in both READMEs; surrounding captions are localized.

## Maintain the diagrams

Edit both SVGs together when boundaries change; keep their dimensions and palette consistent. Match the host/Pi/plugin responsibilities in `docs/architecture.md`, provide a descriptive title and alternative text, and verify XML and browser rendering. Keep critical text inside the canvas.

The package's `files` list includes this directory so the README images remain available in npm packages, not only on GitHub. Keep the existing `assets/cover-webapp.png` separate: it is also used as the Pi package catalog cover.
