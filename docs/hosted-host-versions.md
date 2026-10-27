# Hosted plugin host versions

The host supports exact stable `x.y.z` and `x.y.z-alpha.N` identities. Core
components and the alpha sequence must be non-negative safe integers without
leading zeroes. Other channels, build metadata, prefixes and malformed versions
fail closed. Plugin package versions remain stable-only.

Never strip the alpha suffix: startup markers, diagnostics and paired updates
must preserve the exact package version.

## Consolidated compatibility policy

The former prerelease-host branch and the main implementation differed on whether
an alpha host must require a same-core alpha comparator in every matching range.
The consolidated implementation keeps main's existing behavior, so already
published official plugins remain usable on compatible alpha hosts. It also
retains the alternate branch's explicit alpha comparator support and rejects
unsafe numeric alpha identities.

- Bounded comparator, `^`, `~` and `||` ranges accept stable or exact alpha targets.
- Unknown syntax and wildcards fail the entire range, including another OR branch.
- Full prerelease precedence applies: `0.1.31-alpha.5 < 0.1.31`.
- `0.1.31-alpha.5` matches `>=0.1.0 <1.0.0` and
  `>=0.1.31-alpha.0 <0.1.31`, but not `>=0.1.31` or
  `>=0.1.31-alpha.6`.
- Caret/tilde upper bounds exclude the next boundary's prereleases.
- No additional same-core prerelease opt-in restriction is imposed. This is the
  host's bounded compatibility policy, not npm's complete range grammar.
- SHA-512 archive validation, immutable code, resource checks, busy/unknown
  lifecycle fencing and exact paired-update identities remain unchanged.

## Release regression

`node scripts/test-release-host.mjs` copies the source into a disposable directory,
shares installed dependencies, rewrites the copy's version to `0.1.31-alpha.5`,
builds, then runs launcher/session/bootstrap and installation compatibility tests.
It neither publishes nor mutates the original checkout. CI also retains its real
alpha-identity bootstrap preflight; release artifacts are built/tested after
version selection.

The original failure happened before hosted startup: the installer rejected the
alpha package version synchronously during extension factory initialization.
Missing `host-version.json` was a secondary symptom. Regression tests check actual
package identity, not a hard-coded source version.
