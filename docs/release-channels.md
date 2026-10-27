# Release channels / 发布通道

## Development workflow

```text
feature/* --PR--> alpha --release PR--> main
                  |                    |
                  npm --tag alpha      npm --tag latest
                  0.2.0-alpha.N         0.2.0
```

- Pushes to `alpha` publish alpha packages **after** verification. Pushes to `main`, including merges, publish stable packages after verification. Opening/updating a PR only runs checks; it does not publish.
- `workflow_dispatch` may publish only when run on `alpha` or `main`. No other ref is authorized by the publishing scripts. Both branches use the same serialized publishing group so version allocation and tag changes do not race each other.
- Source checkout is the triggering SHA, never a moving branch head. The release plan binds the SHA, channel, exact version and npm tag; the tarball hash and explicit telemetry-mode verification are preserved (currently disabled-by-default Node/browser checks; optional live Sentry mode requires event receipts). Alpha never updates `latest`. Immediately before publishing, the workflow also checks that its SHA is still that branch's head; an obsolete workflow fails closed rather than publishing older code under a newer number.
- Protect `main` with required CI and PR review in repository settings. Ordinarily merge only a release PR from `alpha`; emergency stable fixes may enter `main` separately and must be merged back to `alpha` before further development. Do not squash repeated alpha→main release merges: preserving ancestry avoids reintroducing the entire previous release diff.
- This change does not create/push remote branches, change protection rules, publish npm packages, or alter npm trusted-publisher settings. Those are deployment operations.

## Version policy

The root `package.json` version expresses the **intended base**, not proof of the latest published version. CI updates package metadata and lockfile only in its isolated artifact checkout, with no bot commits back to either branch. This avoids push races, recursive CI, alpha/stable version merge conflicts and a branch version being committed before npm publication succeeds.

- If the source base exceeds npm `latest`, use it. Otherwise choose the next patch after `latest`.
- Stable publishes that base (e.g. `0.1.30`). Alpha publishes `base-alpha.N`; its counter advances numerically based on npm's `alpha` tag and never moves the existing alpha line backwards.
- Default: `latest=0.1.29`, source `0.1.27` → `0.1.30-alpha.1`, `.2`, … → stable `0.1.30`.
- For a new feature batch, intentionally set the source version, e.g. `npm version 0.2.0 --no-git-tag-version`, and commit both manifests. This yields `0.2.0-alpha.N` → stable `0.2.0`. A separate stable `0.1.30` hotfix does not interrupt this alpha line.
- When preparing a desktop shell, explicitly set its package version and build number as required by the existing desktop release procedure; do not infer npm publication from development source metadata.
- A formal release is a new package built and verified from the reviewed stable commit; merely pointing npm `latest` at `0.2.0-alpha.3` is **not** promotion to `0.2.0`.
- Failed pre-publish builds consume no version. A complete workflow rerun recalculates from registry tags; if an earlier run already published, it may publish the next number. Never overwrite/unpublish a version to reuse its number. The serialized Actions group can coalesce pending runs; this is not a guarantee of one artifact per push.

## Runtime selection and recovery

`update-preferences.json` in `<agentDir>/pi-web/` stores `stable` (default) or `alpha`. It is server-owned and atomically written. GET checks have no install side effects. The settings and sidebar shortcut refresh together after saving a preference.

- Stable resolves npm `latest`, which must contain a stable SemVer.
- Preview resolves the newer of `latest` and `alpha`; absent alpha falls back to stable, but malformed registry values fail closed.
- Installation pins the displayed version and channel. A moved tag or changed preference is rejected before npm install. Installation uses `package@exact-version`, never a moving dist-tag.
- Switching to a lower stable version requires explicit UI confirmation **and** server-side `allowDowngrade: true`. Preview does not offer older alpha packages.
- The package manifest declares `piWebappDataVersion`. Releases before this contract are data format 1: they introduced no app-owned irreversible migration. A downgrade is allowed only when both formats match (missing legacy field means 1). This is a compatibility contract, not a backup or arbitrary upstream Pi compatibility guarantee. Authors **must increment it before introducing an incompatible persistent-data change** and provide a separate backup/migration/recovery plan; do not relabel migrated data as compatible to bypass the guard.
- npm selections retain one previous managed selection for startup rollback. Explicit downgrade overrides are bound to the original entry version; desktop overrides are bound to the bundled shell version. A newer installation must not accidentally inherit a downgrade override from an older installation. Existing task/terminal restart blockers and startup recovery remain in place.
- Changing channel cannot run while this updater is saving/installing/restarting. A second tab with stale target information receives a rejection rather than installing the wrong channel.

## Rollout / 首次启用

1. Merge this implementation into `main` to publish a compatible stable business package. **Do not publish an alpha first using the old CI**, which defaults to npm `latest`.
2. Update actual npx/global entry installations, not just their user-directory managed package. Old launchers ignore alpha selections on cold start. For desktop users, distribute a shell containing the updated managed-release helper/backend before enabling alpha. The shell advertises `PI_WEBAPP_DESKTOP_RELEASE_CHANNELS=1`; the new business updater blocks alpha on old shells lacking this capability.
3. Create remote `alpha` from the updated `main`; configure protections and verify the existing npm trusted publisher accepts this workflow/ref configuration. Push a test change to alpha, confirm `npm view pi-webapp dist-tags --json` shows only `alpha` moving, and install it through the preview preference.
4. Exercise cold launch, stable→alpha, alpha→newer stable, explicit alpha→older stable, cancelled confirmation, failed startup and incompatible-data rejection. Then merge a release PR and verify only `latest` moves.

The desktop native installer pipeline and its GitHub prerelease policy are intentionally independent. This feature changes the npm business-package channel, not signing/notarization or native installer promotion.

## Local validation

```bash
npm ci
npm run check
npm run build
npm test
npx playwright test test/browser/update-shortcut.spec.ts test/browser/update-channels.spec.ts
```

When testing from a live managed launcher, unset inherited `PI_WEBAPP_RESTART_PORT` / `PI_WEBAPP_RESTART_TOKEN` / `PI_WEBAPP_LAUNCHER_NONCE` for child test commands so test servers do not try to bind the live application port. Never run npm publish as a test.
