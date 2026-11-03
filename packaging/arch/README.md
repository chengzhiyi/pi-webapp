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

Update the recipe as part of a desktop release PR and commit the result:

```bash
node packaging/arch/update.mjs desktop-v0.1.39-b16
git add packaging/arch/PKGBUILD packaging/arch/.SRCINFO
```

The updater rewrites both metadata files directly and does not require `makepkg`, so it also works on macOS. Pull requests touching `packaging/arch/**` run the **AUR package → check** job. It verifies the committed `.SRCINFO` with `makepkg --printsrcinfo` as an unprivileged user inside `archlinux:latest`.

AUR publication is a separate manual step after the update is reviewed and merged into `alpha`. Run **AUR package → Run workflow** on `alpha`. The publish job uses the protected `aur` environment, which requires owner approval and contains the AUR credentials. It verifies the metadata as an unprivileged user, checks AUR's pinned Ed25519 host fingerprint, and pushes only `PKGBUILD` and `.SRCINFO` to `ssh://aur@aur.archlinux.org/pi-webapp-bin.git`.

Configure these secrets in the `aur` environment for the AUR account that owns the package:

- `AUR_SSH_PRIVATE_KEY`: an SSH private key accepted by AUR;
- `AUR_USERNAME`: Git author name;
- `AUR_EMAIL`: Git author email.

The first AUR upload must create the `pi-webapp-bin` repository through the normal AUR submission process. The workflow cannot grant package ownership or add a co-maintainer.
