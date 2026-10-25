# Development-only public protocol snapshot

`chengzhiyi-pi-web-protocol-0.2.0-dev.1.tgz` is a prebuilt first-party npm artifact,
not a published registry release and not an Excalidraw implementation bundle.
It preserves existing v1 exports and adds the hosted v2 data/runtime contract.

- Source: https://github.com/chengzhiyi/pi-extensions
- Local source branch: `feat/excalidraw-hosted-v2`
- Source commit: `6328c63` (not yet pushed); additive RPC error status/reason fields
- Package version in this development snapshot: `0.2.0-dev.1`
- SHA-256: `90f877fd5a6f2c49cd0d41431141e16321142c8a741177755a3409ec1501a8d6`
- Contents: TypeScript-compiled public protocol JS/declarations, package metadata,
  README and MIT LICENSE. No model/service credentials or editor dependencies.

Reproduction: export `packages/protocol` at that source commit into an isolated
checkout, set only its package version to `0.2.0-dev.1`, remove release-fingerprint
metadata, add `piWebappSourceRevision: "6328c63"`, run `tsc -p tsconfig.json` with
TypeScript 7.0.2, then `npm pack --ignore-scripts`. The lockfile binds the resulting
tarball with SHA-512 integrity. This snapshot is committed so verification does
not depend on a live sibling checkout or a nonexistent npm version.

CI preserves a locked snapshot for verification and blocks host publication.
Before release, publish/pin the reviewed protocol through the normal authorized
release process and remove this development artifact. Do not publish a host that
silently substitutes an older v1 registry `latest` for the required v2 contract.
