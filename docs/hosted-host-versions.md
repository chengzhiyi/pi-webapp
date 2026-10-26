# Hosted plugin host versions

The host package currently publishes two channels: exact stable `x.y.z` and
`x.y.z-alpha.N` (`N` is a non-negative safe integer without leading zeroes).
Other prerelease channels, build metadata, prefixes, malformed or unsafe numeric
versions fail closed. Supporting a new channel requires an explicit policy change.

Host identity is **not** plugin compatibility: preserve the exact package version
in startup markers, update diagnostics and paired-update checks. Never remove the
alpha suffix to pretend that a candidate is a stable release.

## Compatibility policy

- Host ranges retain the bounded comparator / `^` / `~` / `||` grammar. No wildcard
  or unknown syntax is accepted, even in another OR branch.
- Alpha precedes the stable release of the same core version; alpha sequence
  numbers compare numerically.
- A prerelease host additionally requires an explicit `-alpha.N` comparator with
  the **same major/minor/patch** in the matching OR branch. This mirrors SemVer's
  prerelease opt-in rule, within our deliberately smaller supported grammar.
- For example, `0.1.31-alpha.5` matches `>=0.1.31-alpha.0 <0.1.31`, but not
  `>=0.1.0 <1.0.0`, `>=0.1.31`, or `>=0.1.30-alpha.0 <1.0.0`.
- Plugin archive/catalog/installed versions remain exact stable versions. This is
  host-channel support, not permission to install prerelease plugin packages.

This is intentionally conservative: an alpha host can start offline with no
optional plugins. Existing stable-only plugin manifests do **not** establish
compatibility with an experimental host. They remain unavailable on alpha unless
the publisher explicitly opts in for that core version. Incompatible existing
code cannot load; installation records and user data are preserved. No automatic
manifest rewriting, registry override or stable-version impersonation is used.
The trade-off is that currently published stable-only plugins may be unavailable
on alpha; this PR does not silently widen their compatibility promises.

Archive SHA-512, immutable versions, resource validation, paired-update identity,
and busy/unknown lifecycle fencing are unchanged.

## Release regression

`node scripts/test-release-host.mjs` creates a disposable copy, shares only the
installed dependencies, rewrites its package version to the incident candidate
`0.1.31-alpha.5`, builds, and runs real launcher/session/bootstrap plus compatibility
tests. It does not query release tags, publish, or mutate the checkout. Core PR
verification runs it in addition to the existing suite. The publish job still
builds and tests **after** `prepare-release`; no gate is moved or bypassed.

The bootstrap regression checks resource-loader factory errors as well as session
binding errors and compares the persisted marker against the actual package
version rather than hard-coding a source stable version. With published fixtures,
it verifies rejection of an incompatible package; compatible hosts still exercise
the existing hot-activation event path.

## Incident root cause

At source `0b705bc257f58dea44aff09b62868277fe64cd62`, rewriting the package to
`0.1.31-alpha.5` reproduces all three reported failures. The installer throws
synchronously during `piWeb()` factory initialization. The resource loader catches
that factory exception as `<inline:1>: Host requires an exact stable version`;
`bindExtensions` therefore reports no error for that absent extension. Hosted
startup never runs and cannot create `host-version.json`. The missing marker is a
secondary symptom, not a separate filesystem race. After constructor support is
fixed, the old hard-coded marker assertion would also fail on any release version
other than `0.1.29`; the regression now checks exact package identity.
