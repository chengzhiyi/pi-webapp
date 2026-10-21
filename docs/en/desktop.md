# Desktop test builds

::: warning Not a general cross-platform release
Validated downloads currently target **macOS Apple Silicon (arm64)** only. Windows/Linux packaging configuration is not a validated release. This page covers users; build/operator material remains in the [original desktop notes](https://github.com/chengzhiyi/pi-webapp/blob/main/docs/desktop.md).
:::

The app is named **pi**, includes Node/Pi, can reuse a compatible backend, opens the same service in a browser, and offers background-task choices on exit. Global Node/Pi installation is not required.

## Download, verify, and install

1. Use the project's [GitHub Releases](https://github.com/chengzhiyi/pi-webapp/releases). Select a `desktop-v...` prerelease you have explicitly been invited to test. Download the arm64 DMG and `SHA256SUMS` from **the same release**, not an unknown forwarded installer or source ZIP.
2. Run `shasum -a 256 <DMG-path>` and compare its matching manifest line. Stop on mismatch. If you downloaded only the DMG, missing ZIP files do not invalidate the DMG's own comparison.
3. Finish tasks and quit the old desktop. Stop its owned backend before replacing that runtime; leave still-needed external Web backends alone. Do not delete Pi data. Drag **pi.app** into Applications. An older **Pi Webapp.app** is not automatically replaced; update Dock shortcuts.
4. Verify the installed app:

   ```bash
   codesign --verify --deep --strict --verbose=2 "/Applications/pi.app"
   ```

   Stop and report failures. **Do not re-sign the download to hide a failed verification.**
5. Try opening it. Build 7 onward uses complete **ad-hoc signatures**, but has **no Developer ID publisher identity and no Apple notarization**. Gatekeeper may still block it. Only after checking the source, checksum, signature, and consciously deciding to trust the test build, use **System Settings → Privacy & Security → Open Anyway** if macOS offers it.
6. If download quarantine still prevents launch, a conscious tester can make a manual, **app-scoped** exception only after the above checks:

   ```bash
   codesign --verify --deep --strict --verbose=2 "/Applications/pi.app" &&
   xattr -dr com.apple.quarantine "/Applications/pi.app"
   ```

   This bypasses that app's download quarantine; it is **not Apple certification**. Never disable Gatekeeper/SIP globally, use this for unknown software, or blindly add sudo. A checksum and ad-hoc signature prove neither developer identity nor software safety. The project does not run this automatically.
7. Check version, desktop build number, and executable location in **pi → 关于 pi (About pi)**. Then [configure a model and send a first message](./getting-started#_3-configure-a-model-and-send-a-first-message).

Old downloads are not retroactively fixed by source changes; published installers must not be overwritten. Test updates require verified, manual installation rather than automatic installation. Use the Web version if you do not accept these limitations. The [full installation/operator notes](https://github.com/chengzhiyi/pi-webapp/blob/main/docs/desktop-testing.md) remain available.

Report OS version, chip, build number, sanitized errors, and verification results. Exclude tokens, `auth.json`, private keys, and full local paths.
