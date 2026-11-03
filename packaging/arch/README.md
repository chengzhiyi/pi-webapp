# Arch Linux / AUR packaging

`pi-webapp-bin` installs the official Linux AppImage from the matching desktop prerelease. The package extracts it under `/opt/pi-webapp`, installs `/usr/bin/pi-webapp`, and provides a separate `pi-webapp.desktop` entry and icon. It does not compile Pi or modify the user's Pi data.

## Build and install

```bash
cd packaging/arch
makepkg -sri
```

The source URL and SHA-256 hash must come from the same GitHub desktop release. `update.mjs` updates both `PKGBUILD` and `.SRCINFO`:

```bash
# Newest published desktop release
node packaging/arch/update.mjs

# A specific release
node packaging/arch/update.mjs desktop-v0.1.39-b16
```

The updater checks that the AppImage and `SHA256SUMS` assets exist and takes the hash from that file. It does not download the AppImage itself. Run `makepkg --printsrcinfo` and compare it with `.SRCINFO` after manual edits.

## Moving from a manually installed AppImage

Pacman does not manage an AppImage placed in `~/Applications`. Before installing the AUR package:

1. Move the old AppImage to a backup directory outside the application menu, or delete it after verifying the pacman installation.
2. Remove any manually created `pi.desktop`/Pi Webapp shortcut from `~/.local/share/applications` and the old desktop entry from KDE. Do not remove files you did not create yourself.
3. Install `pi-webapp-bin` and start **pi** from the application menu. Check that only one entry remains.
4. Keep the backup until the packaged application opens and reconnects to your existing Pi service and chats.

The package preserves `~/.pi` and does not stop an already running compatible service.

## Updating and publishing

`.github/workflows/aur.yml` checks for a new desktop release daily and can also be run manually. Its default path opens a review PR to `alpha` with updated `PKGBUILD` and `.SRCINFO`; it never publishes to AUR automatically.

AUR publication is a separate manual step after that update is reviewed and merged. Run **AUR package → Run workflow** with `publish=true`. This pushes only the reviewed `PKGBUILD` and `.SRCINFO` to `ssh://aur@aur.archlinux.org/pi-webapp-bin.git`.

Configure these repository secrets for the AUR account that owns the package:

- `AUR_SSH_PRIVATE_KEY`: an SSH private key accepted by AUR;
- `AUR_USERNAME`: Git author name;
- `AUR_EMAIL`: Git author email.

The first AUR upload must create the `pi-webapp-bin` repository through the normal AUR submission process. The workflow cannot grant package ownership or add a co-maintainer.
