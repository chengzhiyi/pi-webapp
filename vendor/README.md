# Development-only public protocol snapshot

`chengzhiyi-pi-web-protocol-0.2.0-dev.0.tgz` is a prebuilt first-party npm artifact,
not a published registry release and not an Excalidraw implementation bundle.
It preserves existing v1 exports and adds the hosted v2 data/runtime contract.

- Source: https://github.com/chengzhiyi/pi-extensions
- Local source branch: `feat/excalidraw-hosted-v2`
- Source commit: `3e6bd11` (not yet pushed)
- Package version in this development snapshot: `0.2.0-dev.0`
- SHA-256: `5dd57ec87393f846e927423adc9f0396eb3f424353b6467486b3b26b8aed1dc3`
- Contents: TypeScript-compiled public protocol JS/declarations, package metadata,
  README and MIT LICENSE. No model/service credentials or editor dependencies.

Reproduction: export `packages/protocol` at that source commit into an isolated
checkout, set only its package version to `0.2.0-dev.0`, remove release-fingerprint
metadata, add `piWebappSourceRevision: "3e6bd11"`, run `tsc -p tsconfig.json` with
TypeScript 7.0.2, then `npm pack --ignore-scripts`. The lockfile binds the resulting
tarball with SHA-512 integrity. This snapshot is committed so verification does
not depend on a live sibling checkout or a nonexistent npm version.

CI preserves a locked snapshot for verification and blocks host publication.
Before release, publish/pin the reviewed protocol through the normal authorized
release process and remove this development artifact. Do not publish a host that
silently substitutes an older v1 registry `latest` for the required v2 contract.
