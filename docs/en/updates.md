# Updates & recovery

Finish or explicitly pause work in **all** chats and terminals before updating, and save important changes. Restarting the service ends background tasks; saved history does not keep processes running. Follow the procedure for your actual entry point.

## npm background launcher (npx / global command)

**Settings → General → App updates** checks npm. When running from an npm package's background launcher, **Update and restart** installs a verified release under `pi-web/releases/` in Pi's data directory, restarts the backend, and reloads the original address.

- Both npx and global-command launches are supported; later launches select the managed release.
- This **does not modify the npm global installation**. The global package version may differ from the running version; check runtime information in Settings.
- If the new version cannot start, the launcher attempts to restore the previous service. This does not guarantee recovery of active work.

If the page does not return:

```bash
npx pi-webapp status
```

Global installs can use `pi-webapp status`. Check `~/.pi/agent/pi-web/launcher.log` (Windows: `%USERPROFILE%\.pi\agent\pi-web\launcher.log`; custom data roots are covered in [configuration](./reference)). Confirm there is no active work before starting through the original entry point. Report versions and sanitized errors. **Do not delete `~/.pi` or manually alter managed-release directories as a repair shortcut.**

## /web inside an existing Pi

This mode shows versions but cannot restart from the web page. Finish work, then use Pi's package update flow for the installed extension, for example outside the Pi terminal:

```bash
pi update npm:pi-webapp
```

Use the source saved at installation; check `pi list` and your installed version's `pi update --help`. In current Pi, bare `pi update` updates Pi itself, not the extension. Reload extensions or restart Pi, then enter `/web`. If Pi itself is too old, update it separately; its version is distinct from the pi-webapp extension version.

## Source checkout

After updating trusted source, run `npm ci` and `npm run build` in the repository root. For the launcher use `npm run stop` then `npm run start`. With `pi -e .`, rebuild, then enter `/reload` and `/web` inside Pi. Refreshing an old page does not replace the backend bridge.

## Desktop test package

Check desktop and Web runtime versions separately. Test packages without a publisher signature support verified downloads and manual Finder installation, not automatic installation. Quit the old app and stop its owned backend if needed before replacing it; a compatible external Web backend need not stop. See the [desktop guide](./desktop).
