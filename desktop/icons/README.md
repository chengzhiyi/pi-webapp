# Pi Webapp icon

Original artwork for this project, covered by the repository's MIT license.

- **π**: a custom-drawn monogram for Pi (no fonts or third-party logo assets).
- **>_**: a small terminal prompt for the local coding/agent workflow.
- Deep teal tile (`#244B50` → `#0B202A`), ivory ink (`#FFFEF5` → `#DDEEE4`),
  mint accent (`#87E7CB`). A subtle rim keeps the tile visible on dark desktops.
- The 1024px canvas includes a 64px transparent margin; the tile has rounded
  corners and no baked-in desktop background or drop shadow.

Edit `icon.svg`, then run `npm run desktop:icons`. This requires Playwright
Chromium, or `PI_WEB_TEST_CHROME=true` with an installed Google Chrome. The
cross-platform generator uses no image services or platform-specific converters.
Commit all three generated assets together:

- `icon.png`: 1024×1024 RGBA, used by Linux and Electron windows/development Dock.
- `icon.icns`: macOS standard and Retina sizes through 1024px.
- `icon.ico`: PNG entries at 16, 24, 32, 48, 64, 128 and 256px for Windows.

`npm run test:desktop` validates the containers, dimensions and packaging config.
Normal desktop builds consume these files without re-rendering them. For macOS
release validation, also check `CFBundleIconFile` and compare the bundled ICNS
with this source; the packaged smoke test verifies that the PNG loads via
Electron's native image decoder from inside the ASAR.
