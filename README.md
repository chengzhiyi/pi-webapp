# pi-webapp

[简体中文](README.zh-CN.md)

![pi-webapp cover](assets/cover-webapp.png)

**pi-webapp** opens the active Pi coding agent session in a local browser. Pi continues to run the agent, tools, and session storage; the browser provides a live interface for conversation and control.

## Install and open

Requires Node.js 22.19 or later. To open the web interface directly:

```bash
npx pi-webapp
```

This starts Pi in the background and opens the default browser on a local graphical desktop, leaving the terminal free. If Pi is missing, the launcher installs the official `@earendil-works/pi-coding-agent` package with npm. An existing Pi installation must be version 0.87.1 or later. The launcher does not replace an older installation automatically. Running the launcher again reopens the existing server. Remote or headless sessions print the address instead; set `PI_WEBAPP_AUTO_OPEN=0` to disable automatic opening.

Use `npx pi-webapp status` to show the address and `npx pi-webapp stop` to stop the background service. After a global install, use `pi-webapp status` and `pi-webapp stop`.

You can also install the launcher globally:

```bash
npm install -g pi-webapp
pi-webapp
```

To use the extension inside an existing Pi terminal, the original workflow remains available:

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
- Manage appearance, Pi packages, extensions, skills, and models from the settings panel. The Models page can add models, edit display names, context windows, output limits, and input types, and restore built-in defaults; changes are saved to Pi's `models.json`. Browser sign-in opens the provider's authorization page automatically; manual code entry remains available when a callback cannot reach Pi. Stored provider credentials can also be removed there. Credentials stay in Pi's local `auth.json` and are never returned to the browser.

If you enter `/web` manually in a Pi terminal, that terminal session stays synchronized with the browser. With the launcher, Pi runs in the background. Sessions opened in other workspaces use the Pi SDK and load that workspace's skills and project context. They do not load extensions again in the same process.

On startup, the app discovers workspaces from Pi's saved sessions, so conversations from other directories appear in the sidebar. Workspace records and attachments stay under Pi's existing `pi-web/` data directory. Removing a workspace from the sidebar does not delete its files or sessions; you can add it again manually.

## Develop locally

```bash
npm install
npm run check
npm run test
npm run build
npm run start
npm run status
npm run stop
```

`npm run start` builds the project, starts Pi in the background, and opens the web interface. After editing the extension, run `npm run stop` followed by `npm run start`. If you develop with `pi -e .`, enter `/reload` and `/web` in Pi after rebuilding. Refreshing an old browser page alone does not replace the running bridge.

The source lives in `extension/`, `shared/`, and `web/src/`. The npm package contains only the bundled, minified JavaScript extension, built web assets, cover image, and the English and Chinese READMEs. No TypeScript source or source maps are published. Minification makes the shipped code harder to read; it does not encrypt JavaScript.

## Publish

`npm publish` runs the checks, tests, and production build. The `pi-package` keyword makes the published npm package eligible for the [Pi package catalog](https://pi.dev/packages); catalog updates may lag behind npm.

GitHub Actions runs `check`, `test`, and `build` on pull requests to `main`. A push to `main` repeats those checks and then publishes the next patch version to npm. The release version is selected from the greater of the source version and the npm `latest` version; it is set in the package during CI and is not committed back to Git. To start a new minor or major series, raise the version in `package.json` and `package-lock.json` in the pull request. Each release also updates the package's `pi.image` URL to its own version.

Before the first automated release, configure npm Trusted Publishing for the `pi-webapp` package: GitHub owner `chengzhiyi`, repository `pi-webapp`, workflow filename `ci.yml`, no environment, and allow direct `npm publish`. This workflow uses GitHub's OIDC identity and does not need an npm token. Keep the package's repository URL in `package.json` aligned with the GitHub repository.

## License

MIT. See the `LICENSE` file.
