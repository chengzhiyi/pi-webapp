import assert from "node:assert/strict";
import test from "node:test";
import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import type { BridgeEvent, SessionView, ViewMessage, LoginEvent, LoginPrompt } from "../shared/bridge-contract.ts";
import { SESSION_SCHEMA_VERSION } from "../shared/bridge-contract.ts";
import { parseBridgeEvent } from "../shared/bridge-events.ts";

const message: ViewMessage = {
  id: "assistant-1", role: "assistant", timestamp: "2026-10-18T00:00:00Z",
  blocks: [{ kind: "text", text: "Hello" }, { kind: "thinking", text: "Reasoning" },
    { kind: "toolCall", text: "{}", toolName: "read", toolCallId: "tool-1" }, { kind: "image", text: "" }],
  usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 1, totalTokens: 3, cost: 0 },
};
const session: SessionView = {
  schemaVersion: SESSION_SCHEMA_VERSION, sessionId: "session-1", cwd: "/workspace", name: "Chat",
  model: null, thinkingLevel: null, thinkingLevels: [], idle: true, contextUsage: null,
  messages: [message], pluginEntries: [],
};

// Compile-time checks: wire types must not acquire browser-owned presentation state.
function wireTypes(view: ViewMessage, event: AuthEvent, prompt: AuthPrompt): void {
  // @ts-expect-error File state belongs only to the browser's optimistic message.
  view.localFiles;
  const loginEvent: LoginEvent = event;
  const { signal: _signal, ...publicPrompt } = prompt;
  const loginPrompt: LoginPrompt = publicPrompt;
  void loginEvent; void loginPrompt;
}
void wireTypes;

function roundtrip(event: BridgeEvent): BridgeEvent {
  return parseBridgeEvent(JSON.parse(JSON.stringify(event)));
}

test("shared contract accepts all six existing wire event variants", () => {
  const events: BridgeEvent[] = [
    { type: "snapshot", session }, { type: "stream", message }, { type: "stream", message: null },
    { type: "workspaces", value: { items: [{ id: "ws", path: "/workspace", title: "Workspace" }], activeId: null,
      sessions: [{ id: "session-1", workspaceId: "ws", path: null, name: "Chat", modified: "now" }] } },
    { type: "error", message: "Failed", errorId: "error-1", requestId: "request-1", operationId: "operation-1", errorCode: "validation_error", errorReported: true },
    { type: "shutdown" }, { type: "shutdown", reconnect: true }, { type: "plugins_changed" },
  ];
  for (const event of events) assert.deepEqual(roundtrip(event), event);
});

test("optional fields and opaque plugin payloads survive without changing the wire shape", () => {
  const event = { type: "snapshot", session: {
    ...session, model: "provider/model", thinkingLevel: "medium", thinkingLevels: ["medium"], idle: false, paused: false,
    contextUsage: { tokens: null, contextWindow: 1000, percent: null }, streaming: message,
    pluginEntries: [{ id: "entry", pluginId: "plugin", kind: "plan", timestamp: "now", data: { revision: 2 }, afterMessageId: "assistant-1" }],
    interactions: [{ requestId: "request", sessionId: session.sessionId, pluginId: "plugin", kind: "approval", data: ["opaque"] }],
    futureField: { supportedLater: true },
  } };
  assert.deepEqual(parseBridgeEvent(event), event);
  assert.deepEqual(roundtrip({ type: "snapshot", session: { ...session, streaming: null } }), { type: "snapshot", session: { ...session, streaming: null } });
  assert.deepEqual(parseBridgeEvent({ type: "stream", message: { ...message, futureField: true } }), { type: "stream", message: { ...message, futureField: true } });
});

test("rejects missing, unknown and incompatible event envelopes", () => {
  for (const value of [null, [], true, "snapshot", {}, { type: 1 }]) assert.throws(() => parseBridgeEvent(value), /Invalid stream event/);
  assert.throws(() => parseBridgeEvent({ type: "future-event" }), /Unsupported stream event/);
  for (const schemaVersion of [undefined, 0, 2, "1"]) {
    assert.throws(() => parseBridgeEvent({ type: "snapshot", session: { ...session, schemaVersion } }), /Unsupported session schema/);
  }
  assert.throws(() => parseBridgeEvent({ type: "snapshot" }), /Invalid session snapshot/);
});

test("validates nested snapshot fields before they reach browser state", () => {
  const invalid: Record<string, unknown>[] = [
    { sessionId: 1 }, { cwd: null }, { name: [] }, { model: {} }, { thinkingLevel: 0 },
    { thinkingLevels: [false] }, { idle: "true" }, { paused: "false" }, { messages: null },
    { messages: [{ ...message, role: "invalid" }] }, { messages: [{ ...message, blocks: [{ kind: "text" }] }] },
    { messages: [{ ...message, blocks: [{ kind: "invalid", text: "" }] }] },
    { messages: [{ ...message, usage: { ...message.usage, cost: Infinity } }] },
    { messages: [{ ...message, isError: "yes" }] }, { messages: [{ ...message, toolName: 7 }] },
    { contextUsage: {} }, { contextUsage: { tokens: 1, contextWindow: "1000", percent: 1 } },
    { pluginEntries: [{}] }, { interactions: [{}] }, { interactions: "pending" }, { streaming: {} },
  ];
  for (const fields of invalid) assert.throws(() => parseBridgeEvent({ type: "snapshot", session: { ...session, ...fields } }), /Invalid session snapshot/);
});

test("validates stream, workspace, error and shutdown payloads", () => {
  const invalid = [
    { type: "stream" }, { type: "stream", message: {} },
    { type: "workspaces", value: { items: [], activeId: null } },
    { type: "workspaces", value: { items: [{ id: "ws", path: "/", title: "W", available: "yes" }], activeId: null, sessions: [] } },
    { type: "workspaces", value: { items: [], activeId: 1, sessions: [] } },
    { type: "workspaces", value: { items: [], activeId: null, sessions: [{ id: "s", workspaceId: "w", path: null, name: "N", modified: "now", idle: "true" }] } },
    { type: "error", message: {} }, { type: "error", message: "Failure", errorReported: "true" },
    { type: "error", message: "Failure", errorId: 1 }, { type: "shutdown", reconnect: "true" },
  ];
  for (const event of invalid) assert.throws(() => parseBridgeEvent(event), /Invalid stream event/);
});

test("validation errors do not include wire content", () => {
  const secret = "private conversation and credential fragment";
  for (const value of [{ type: secret }, { type: "snapshot", session: { schemaVersion: secret } }, { type: "stream", message: { text: secret } }]) {
    assert.throws(() => parseBridgeEvent(value), error => error instanceof Error && !error.message.includes(secret));
  }
});
