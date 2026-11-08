# Changelog

What's new in each release, newest first. Check **Pi Settings → General** for the version you're running, and **pi → About pi** for the desktop build.

pi-webapp ships two ways. The npm package (the web launcher, and the service inside the desktop app) is published on every release, and **Update and restart** installs it in both; see [Updates](./updates). The desktop app gets a new installer build less often. Each entry below is either a desktop build or an npm release with notable changes, and lists everything since the entry before it. **Unreleased** is what the [preview channel](./updates#channels) has that no stable release has yet.

## Unreleased {#unreleased}

### Highlights

- **Floating message box.** When the tool panel is fullscreen and covers the conversation, the message box floats over the panel. It shares its draft, attachments, queue and slash commands with the normal one. Collapse it to an icon that shows what Pi is doing, drag it where you like, or toggle it with ⌘/Ctrl+J. Messages you send from it tell Pi which tab you're looking at, and from the file browser, which file and lines you've selected. While Pi works it shows progress, then the reply; expand it to read the conversation or answer a pending approval.
- **Pi can use your terminals.** Ask Pi to run something in a terminal tab ("run the tests in this terminal"). It can read a terminal's recent output on its own, but every command it wants to type is shown to you first and waits for **Allow** or **Deny**. See [Terminal](./workspace-tools#terminal).

### Improvements and fixes

- Updates that nothing can start any more are deleted automatically, about a minute after startup. Each one took around 400 MB. Only versions that aren't running, aren't selected and are more than 24 hours old are removed, and nothing is removed while an update is in progress.
- **Pencil plugin (optional).** UI design on OpenPencil, installed from **Plugins**. You edit `.fig` designs in the workspace, and Pi proposes changes that you accept or reject. Pencil follows pi's theme and language.
- Plugins can download JPG and WebP images, as well as PNG and SVG.
- When a plugin refuses `pi-webapp stop` because of unsaved work, your other plugins keep running and the next stop works. Before, every later stop failed until `stop --force`.
- When the desktop app can't connect to an existing service, it now says whether the service timed out or couldn't be reached, shows which one it is (version, how it was started, process ID, working directory), and offers its exact stop command to copy. See [Desktop app](./desktop#cannot-connect).
- The file editor's line-number gutter no longer turns transparent when you scroll sideways.
- Plugin recovery warnings no longer appear for records that block nothing.

### For plugin developers

- A local development folder or a package archive can stand in for an official hosted plugin.
- A plugin that isn't official yet can be developed from a local folder: it describes itself in a `piWebappCatalog` block in its `package.json` (name, description and reviewed policy, the same shape as an official catalog entry) and is never labelled Official. Package archives are for official plugins only.
- Hosted plugins can ship WebAssembly (with `browser.wasm`), bind binary workspace files, set their own invoke timeout, and return images with tool results.
- Repeated failed switches to a development build no longer use up the plugin's version budget.

## pi 0.1.53 · 2026-11-05 {#v0-1-53}

npm release. Install it with **Update and restart**, in the web launcher or the desktop app.

### Highlights

- **File browser with editing.** **Workspace files** now shows the preview on the left and the folder tree on the right, with a clickable path to jump between folders. Search files by name, or start with `?` to search inside them. In a Git repository, changed, new and conflicted files are coloured and marked with a dot. Code, text and Markdown files open in an editor with syntax highlighting and find; save with ⌘/Ctrl+S. If the file changed on disk while you were editing, you choose whether to reload or overwrite. See [Files](./workspace-tools#files).

## Desktop build 17 · pi 0.1.52 · 2026-11-04 {#build-17}

### Highlights

- **Clearer errors.** Temporary errors appear as notifications at the top of the window, some with a one-click fix, instead of pushing the layout around. A model error in the conversation is broken down into message, status, type and request ID, with a button to copy the details.
- **Better-looking replies.** Chat replies use the same Markdown renderer as file previews: tables and other GitHub-style Markdown, math, and highlighted code, and long replies stream more smoothly.
- **Arch Linux package.** An AUR recipe for the desktop app; see [Desktop app](./desktop#install).

### Improvements and fixes

- Conversation titles use the full width available.
- The elapsed-time counter of a running reply is kept when you switch chats and back.
- Pi extensions keep working in workspace sessions.
- The "an update is already in progress" error is translated.

## Desktop build 16 · pi 0.1.39 · 2026-11-03 {#build-16}

### Highlights

- **Rename and delete chats.** From a chat's **…** menu. Empty chats are no longer listed. See [Rename or delete a chat](./sessions#rename-or-delete-a-chat).
- **Right-click menus in the desktop app.** Copy selected text, the usual edit actions in text fields, **Copy Link Address** on links, and the **…** actions on a workspace or chat row. The native menus follow the interface language.
- **Images in Markdown previews.** Images that a workspace Markdown file links with a relative path now show in its preview.
- **Help links to this guide.** The desktop app's **Help** menu opens this site in your language.

### Improvements and fixes

- `pi-webapp stop --force` stops a service that won't stop by itself; see [Command line](./reference/cli).
- Copy buttons work even when the browser refuses clipboard access.
- Selected text in a terminal is visible in light and dark themes, and ⌘/Ctrl+C copies it.
- An old model error disappears once a retry succeeds.
- A plugin can no longer block an app update; you're asked to confirm instead.

### For plugin developers

- Hosted plugins can declare secrets, network access, scheduled jobs, sessions and workspace-scoped state. Secrets can be set by signing in to GitHub in the browser.
- Development-folder mode switches to your local plugin build automatically.

## Desktop builds 12–14 · pi 0.1.39 · 2026-10-31 {#build-14}

Desktop reliability fixes:

- Quitting stays responsive while a page is loading or the service has failed.
- Unsaved drawings can be recovered across desktop windows.
- A service shared with the web launcher is handed over safely to the newest desktop app.
- An uncertain launcher state on Windows waits instead of failing.

## Desktop build 11 · pi 0.1.39 · 2026-10-30 {#build-11}

### Highlights

- **Diagrams with Excalidraw.** Ask Pi for an architecture diagram or a flowchart and edit it by hand on an Excalidraw canvas. The plugin is optional; see [Diagrams](./diagrams).
- **Stable or preview updates.** Choose under **Update preference** whether to follow stable releases only, or preview releases too. See [Stable or preview](./updates#channels).
- **Edit the queue.** Messages waiting in **Pending prompts** can be edited, deleted or sent as a steer. See [Send while Pi is working](./conversation#send-while-pi-is-working).

### Improvements and fixes

- While you wait for a reply, an indicator shows that Pi is working and for how long.
- Error reporting is off by default.
- Plugins run isolated from the app: a failing plugin doesn't take the app down, and plugin and app updates can be rolled back.
- A draft restored after a reload shows as a small notice instead of a large panel.

## Desktop build 10 · pi 0.1.28 · 2026-10-24 {#build-10}

- The desktop app can update its service from inside the app, without a new installer. Earlier installs are migrated automatically.

## Desktop build 9 · pi 0.1.26 · 2026-10-23 {#build-9}

- **Steer Pi while it works.** Send a follow-up for later, or a steer that reaches Pi at its next opportunity. See [Send while Pi is working](./conversation#send-while-pi-is-working).
- **Resize the tool panel** by dragging its edge, and widen it without losing the sidebar.
- The desktop app checks for updates and installs them only with your consent, after verifying them.

## Desktop builds 5–8 · pi 0.1.20–0.1.24 · 2026-10-20 to 2026-10-21 {#build-8}

- **The first desktop app**, for macOS (Apple Silicon and Intel), Windows x64 and Linux x64, with Node.js and Pi bundled. See [Desktop app](./desktop).

## Before the desktop app

Highlights of the npm releases up to pi 0.1.19:

- A workspace sidebar with a file tree and previews, real terminals that keep running in the background, and Git history with inline diff review. See [Files, terminal and Git](./workspace-tools).
- Chats in different workspaces run independently in the background. See [Sessions and workspaces](./sessions).
- A sidebar shortcut that appears when an update is available and installs it in one click.
