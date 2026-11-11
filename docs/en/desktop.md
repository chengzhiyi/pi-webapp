# Desktop app

This page covers installing the desktop app, what is different from the web version, and how to update and quit it.

The desktop app is called **pi**. It shows the same workbench in its own window and bundles Node.js and Pi, so you don't install either. You still bring your own model credentials, Git and SSH setup, and project toolchains.

::: warning Test builds
Desktop builds are published as **unsigned test pre-releases**. They are meant for people who are comfortable verifying a download. macOS builds carry an ad-hoc signature but no Apple notarization, so Gatekeeper may block them. Windows and Linux builds are unsigned. If you'd rather not accept that, use the [web launcher](./getting-started), which has the same features.
:::

## What you can download

Find the newest `desktop-v…` pre-release on the [GitHub Releases page](https://github.com/chengzhiyi/pi-webapp/releases). Each release lists the installers for the platforms below. Windows ARM and Linux ARM are not included.

| Platform | File |
| --- | --- |
| macOS, Apple Silicon | `…-mac-arm64.dmg` |
| macOS, Intel | `…-mac-x64.dmg` |
| Windows, x64 | `…-win-x64.exe` |
| Linux, x64 | `…-linux-x86_64.AppImage` |

Download the installer and the file named `SHA256SUMS` **from the same release**. Don't use an installer someone forwarded to you or a source ZIP.

## Verify the download

Compare your installer's checksum with its line in `SHA256SUMS`.

```bash
shasum -a 256 ~/Downloads/pi-*-mac-arm64.dmg
```

On Linux use `sha256sum`. In PowerShell use `Get-FileHash <file> -Algorithm SHA256`. If it doesn't match, stop and don't install it. The checksum proves the file is the one that was published; it doesn't prove the software is safe.

## Install {#install}

::: details macOS
1. Quit any older copy of the desktop app first, and stop the backend it started if it asks. Don't delete `~/.pi`.
2. Open the DMG and drag **pi.app** into **Applications**. An older **Pi Webapp.app** isn't replaced by the new name, so update your Dock shortcut.
3. Verify the app's signature:

   ```bash
   codesign --verify --deep --strict --verbose=2 "/Applications/pi.app"
   ```

   If this fails, stop. Don't re-sign the app to make the error go away.

4. Open the app. If macOS blocks it, check **System Settings → Privacy & Security** for **Open Anyway**, but only after you've verified the source, checksum and signature and decided to trust this test build.
5. If the download quarantine still prevents launch, you can remove it from this one app after the checks above:

   ```bash
   codesign --verify --deep --strict --verbose=2 "/Applications/pi.app" &&
   xattr -dr com.apple.quarantine "/Applications/pi.app"
   ```

   This skips macOS's download check for **that app only**. It is not Apple certification. Never disable Gatekeeper or SIP globally.
:::

::: details Windows
Run the `.exe` installer. Because it is unsigned, Windows may warn that the publisher is unknown. Continue only if the checksum matched.
:::

::: details Linux
Make the AppImage executable and run it:

```bash
chmod +x pi-*-linux-x86_64.AppImage
./pi-*-linux-x86_64.AppImage
```

If your system has no FUSE support, run `./pi-*-linux-x86_64.AppImage --appimage-extract-and-run`.
:::

On Arch Linux, an AUR recipe is maintained in [`packaging/arch`](https://github.com/chengzhiyi/pi-webapp/tree/alpha/packaging/arch). Its README covers building with `makepkg`, automated updates, and moving from a manually installed AppImage without duplicate menu entries.

After the first start, confirm the version: on macOS choose **pi → 关于 pi** (About pi). It shows the shell version, the desktop build number and the running pi-webapp version. Then follow [Quick start → Connect a model](./getting-started#_3-connect-a-model).

## How it differs from the web launcher

- **Same data.** The desktop app uses the same Pi data folder (`~/.pi/agent`) as `npx pi-webapp` and the Pi terminal, so your sessions, models and credentials are all shared.
- **Reuses a running service.** If a compatible pi-webapp service is already running (started by `npx pi-webapp`, for example), the desktop window connects to it instead of starting a second one. Otherwise it starts its own.
- **Bundled runtime.** It runs the Node.js and Pi it ships with. A service it reuses keeps its own Pi version.
- **No browser needed**, though **Window → 在浏览器中打开** (Open in browser) opens the same service in your browser.

The desktop menus are currently in Chinese. The ones you are likely to use:

| Menu item | Meaning |
| --- | --- |
| **pi → 关于 pi** | About pi: shell version, build number, running version, app location, whether it owns the service |
| **pi → 检查桌面更新…** | Check for desktop updates |
| **pi → 取消桌面更新下载** | Cancel the update download |
| **pi → 安全切换到当前桌面启动器…** | Safely switch a running service to this desktop's launcher (see [Updates](./updates)) |
| **pi → 退出…** | Quit (**Cmd/Ctrl+Q**) |
| **窗口 → 重新加载界面** | Reload the window (**Cmd/Ctrl+R**) |
| **窗口 → 在浏览器中打开** | Open the service in your browser |
| **窗口 → 打开日志目录** | Open the folder with the service log |

Right-click selected text to copy it. Editable fields offer the standard undo, cut, copy, paste and select-all actions, and links offer **Copy Link Address**. Right-click a workspace or chat row to open the same actions menu as its **…** button.

Choose **Always Open in Browser** in the external-link confirmation to open future links immediately. Restore confirmations at any time with **pi → Ask Before Opening External Links**.

## Quit

Quitting asks **是否同时停止后台服务？** ("Also stop the background service?"):

| Button | What happens |
| --- | --- |
| **取消** | Cancel; stay in the app. |
| **仅关窗口，后台继续** | Close the window only. The service, running chats and terminals keep going. Stop it later with `pi-webapp stop`, or reopen the app. |
| **停止服务并退出** | Stop the service and quit. This ends all running chats and terminals, and disconnects any browser using the service. |

If the app is connected to a service it didn't start, quitting says **当前连接的是已有服务，关闭桌面不会停止它** ("this is an existing service; closing the desktop won't stop it") and only closes the window.

## When the app can't connect to the existing service {#cannot-connect}

If a pi-webapp service is already running but doesn't pass the desktop's checks, the app shows **Cannot connect to the existing service** (**暂时无法连接已有服务**) instead of opening a window. The message says what went wrong:

| Message | Meaning |
| --- | --- |
| Did not answer its health check within 5 seconds | The service is running but stuck or very busy. |
| The connection was refused or closed | Nothing is answering at its address. It may have exited or still be starting. |
| Returned an unexpected health check response / invalid data | It answered, but not like a pi-webapp service the desktop can use. |

Under the message, the dialog names the service from `~/.pi/agent/pi-web/launcher.json`: its version, how it was started (`npm` for the web launcher or a development checkout, `desktop` for a desktop app), its process ID and its working directory. Use these to tell which copy it is, for example a development backend left running from another checkout.

**Check Again** only checks again. It never restarts, upgrades or stops the service.

The desktop app doesn't stop a service it didn't start, so a half-finished save in someone else's window can't be lost by a click here. When the service can be stopped, the dialog shows the exact stop command instead, and **Copy Stop Command** (**复制停止命令**) copies it. The command runs `pi-webapp stop` with the Node.js and launcher bundled in the app, so it works even if `pi-webapp` isn't installed. Paste it into a terminal:

1. Run the copied command. It asks the service to finish saving plugin views and exit, the same as `pi-webapp stop`.
2. If it keeps waiting or times out, run it again with ` --force` at the end. This skips plugin save confirmations, so **unsaved plugin edits may be lost**. If the service doesn't respond within 5 seconds, it ends the service and its child processes.
3. Back in the app, choose **Check Again**. With no service running, the app starts its own.

## Update the desktop app {#update-the-desktop-app}

The shell and the pi-webapp package inside it update separately:

- **Business package** (the pi-webapp version): update from **Pi Settings → General → App updates**, exactly as in [Updates](./updates). This doesn't replace the app.
- **Shell** (the installed app): **pi → 检查桌面更新…**. On macOS Apple Silicon it downloads and verifies the new build and hands it to Finder for a manual install; it never installs an ad-hoc build for you. On other platforms it opens the Releases page, where you pick the installer for your system.

Quit the old app and stop the backend it owns before replacing it. Leave a web service you still use running.

A shared service started by an older desktop keeps that desktop's capabilities. If **Pi Settings → General** says the safe handoff is available only from a newer desktop, first update the business package on **Stable**, then use **pi → 安全切换到当前桌面启动器…**. Handoff waits for idle chats, closed terminals and confirmed drawing saves, keeps the local address, and never force-stops the old service.

## Report a problem

Include your OS and chip, the desktop build number from **关于 pi**, what you did, and the exact error. Leave out access tokens, `auth.json`, private keys and full local paths.
