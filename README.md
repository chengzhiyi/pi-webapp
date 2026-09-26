# pi-webapp

![pi-webapp cover](https://unpkg.com/pi-webapp@0.1.0/assets/cover-webapp.png)

**pi-webapp** opens the active Pi coding agent session in a local browser. Pi continues to run the agent, tools, and session storage; the browser provides a live interface for conversation and control.

## Install and open

Requires Node.js 22.19 or later and Pi 0.87.1 or later.

```bash
pi install npm:pi-webapp
pi
```

In Pi, enter `/web` to open the interface in your default browser. Pi also prints the local URL for remote or headless environments. The URL contains a random token valid only for the current Pi process. Enter `/web` again to reopen it.

## Features

- View the current conversation with Markdown, streaming output, expandable reasoning and tool calls, token usage, and a turn-by-turn trace.
- Send messages, stop a run, start a new Pi session, and change the current model or thinking level.
- Browse workspaces and saved sessions. Add a workspace with the native directory picker when available, or use the built-in directory browser over SSH.
- Attach up to 20 files of 20 MB each by selecting, dropping, or pasting them. Images show previews and are also sent as Pi image content.
- Manage appearance, Pi packages, extensions, skills, and models from the settings panel. Provider credentials remain in Pi's local authentication store and are never returned to the browser.

The Pi terminal session that opened `/web` stays synchronized with the browser. Sessions opened in other workspaces use the Pi SDK and load that workspace's skills and project context. They do not load extensions again in the same process.

Workspace records and attachments stay under Pi's existing `pi-web/` data directory for compatibility with earlier releases. Removing a workspace from the sidebar does not delete its files or sessions.

## Develop locally

```bash
npm install
npm run check
npm run test
npm run build
pi -e .
```

After editing the extension, rebuild it, then enter `/reload` and `/web` in Pi. Refreshing an old browser page alone does not replace the running bridge.

The source lives in `extension/`, `shared/`, and `web/src/`. The npm package contains only the bundled, minified JavaScript extension, built web assets, cover image, and this README. No TypeScript source or source maps are published. Minification makes the shipped code harder to read; it does not encrypt JavaScript.

## Publish

`npm publish` runs the checks, tests, and production build. The `pi-package` keyword makes the published npm package eligible for the [Pi package catalog](https://pi.dev/packages); catalog updates may lag behind npm.

## License

MIT. See the `LICENSE` file.
