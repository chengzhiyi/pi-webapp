# ADR-007: Shared browser bridge contract

Status: Accepted

## Context

The Node projection and browser bridge duplicated session, workspace, configuration,
provider and plugin-catalog DTOs. Browser plugin modules imported catalog types
from `extension/`. Those were type-only imports, not a Node runtime dependency,
but ownership and compatibility were implicit. Stream handling checked envelopes
and a few snapshot fields; malformed nested messages could reach React rendering.

## Decision

`shared/bridge-contract.ts` owns the browser-facing wire DTOs and the six existing
NDJSON event variants. It contains no runtime SDK, Node or React imports. Protocol
plugin types and error-correlation types are imported with `import type` only.
Existing Node and browser export paths re-export these types for compatibility.
Provider field aliases retain their existing names on the Node side.

Browser optimistic messages extend the shared message with `localFiles?: File[]`.
That presentation field is not part of the shared wire contract. The transport
session remains independent of browser-owned state.

`shared/bridge-events.ts` validates decoded events before they enter UI state:

- Known events must have valid envelopes and known nested field shapes.
- Session snapshots must use `SESSION_SCHEMA_VERSION`, currently 1.
- Optional fields may be absent. Additive fields are accepted, not treated as a
  new protocol version. Plugin `data` remains opaque and plugin-owned.
- Unsupported events/schemas and malformed payloads produce fixed diagnostic
  messages, without interpolating the payload. JSON syntax diagnostics are also
  replaced before reporting because native SyntaxError messages may contain data.
- Rejected events follow the existing disconnect/reconnect path. A fresh snapshot
  restores state; invalid data must not be used to test the React error boundary.
  That boundary is tested separately with an injected rendering failure.

The wire format, routes and event names do not change. Session schema version,
bridge `protocolVersion` (used for extension reload compatibility), and plugin
`apiVersion` remain separate concerns. No protocol-version bump is necessary for
this ownership refactor and validation of already-declared fields.

## Extension rules

Add or change a wire field in the shared contract, then update its producer,
consumer and relevant validation/compatibility tests together. Keep runtime Pi
objects and browser File/DOM state outside the wire DTO. Preserve old exported
type names while callers migrate. Authentication flow types are checked for
assignability against the Pi SDK by the type-checking test fixture.

Do not weaken validation to make an invalid fixture render. Use a valid wire
fixture and inject a real rendering failure when testing React recovery.

## Scope and verification

`test/bridge-contract.test.ts` covers event variants, optional/additive fields,
opaque plugin payloads, incompatible versions, malformed nested data, diagnostic
privacy, browser-only state separation and Pi authentication type compatibility.
Browser telemetry tests cover early rejection, reconnect, JSON diagnostics and
independent React recovery. Existing background-chat, terminal and Git browser
regressions remain the behavioral guardrails.

This decision does not add generic request validation, validation of every JSON
query response, a new schema dependency, event replay/pagination, new session
selection semantics, or changes to the ADR-001/003/005 ownership and concurrency
rules. Session-control and operation-coordination refactors remain separate work.
