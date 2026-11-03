# Contributing to pi-webapp

Thanks for helping. This guide covers how to set up the project, what a pull request needs, and what CI checks. Small, focused pull requests are reviewed fastest.

## Before you start

- **Bug fixes and small improvements:** open a pull request directly.
- **New features, protocol or plugin API changes, or large refactors:** open an issue first so we can agree on the approach before you write the code.
- **Security problems:** don't open a public issue. Follow [SECURITY.md](SECURITY.md).

## Set up

You need Node.js 22.19 or later.

```bash
git clone https://github.com/chengzhiyi/pi-webapp.git
cd pi-webapp
npm ci
npm run start   # build and launch the local service
```

After changing extension or server code, run `npm run stop` and `npm run start`; reloading the browser doesn't replace the backend. Desktop, plugin and docs workflows are in the [developer guide](docs/en/developers.md); architecture is in [docs/architecture.md](docs/architecture.md).

## Branches

- Branch from `alpha` and open your pull request against `alpha`.
- `main` is the stable channel; maintainers promote `alpha` to `main`.
- Name branches by intent, for example `fix/session-restore` or `feat/workspace-search`.

## Before you push

Run what CI runs:

```bash
npm run lint    # Biome lint; `npm run lint:fix` applies safe fixes
npm run check   # TypeScript for the host and the web UI
npm test        # unit and integration tests
```

While iterating, `npm run test:quick` runs the same unit tests minus a few long soak tests (about a quarter faster). Run the full `npm test` before you push.

If you changed the UI, also run the relevant browser tests with `npm run test:browser` (Playwright).

## Code guidelines

- **Match the surrounding code.** Naming, density, comment style and idioms should look like the file you're editing. There is no formatter; `.editorconfig` sets indentation and line endings.
- **Lint must pass with no errors.** Some rules are still warnings because of older code (see `biome.jsonc`). Don't add new instances of them, and feel free to clean them up in separate pull requests.
- **Keep the layering.** UI code lives in `web/src` and `src/**/client`, the Node host in `src/host/server`, and shared types in `src/contracts`. See [docs/architecture.md](docs/architecture.md); `test/architecture.test.ts` checks some of the boundaries.
- **Add or update tests** for every behavior change. A bug fix should come with a test that fails without it.
- **Don't add dependencies casually.** Explain any new runtime dependency in the pull request; pin exact versions where nearby entries are pinned.
- **Update the docs** (`docs/en/` and its `docs/zh/` counterpart) when user-visible behavior changes.

## Commits and pull request titles

We use [Conventional Commits](https://www.conventionalcommits.org/). Pull requests into `alpha` are squash-merged, so the **pull request title** becomes the commit on `alpha`, and CI checks its format:

```
<type>(<optional scope>): <summary in the imperative mood>
```

Types: `feat`, `fix`, `perf`, `refactor`, `test`, `docs`, `build`, `ci`, `chore`, `style`, `revert`. Add `!` after the type for breaking changes, for example `feat(protocol)!: drop v1 session events`.

Examples:

- `fix: keep queued prompts after a reconnect`
- `feat(workspace): search files by path`

## Pull requests

- Fill in the template: what changed, why, and how you tested it. Include screenshots or a short recording for UI changes.
- Keep each pull request to one concern. Split unrelated changes out.
- All CI checks must pass and a maintainer must approve before merge. Pull requests from first-time contributors need a maintainer to approve the CI run.
- Reply to review comments by pushing new commits. Don't force-push during review unless asked, so reviewers can see what changed.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
