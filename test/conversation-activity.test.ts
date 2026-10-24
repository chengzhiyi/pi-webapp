import assert from "node:assert/strict";
import test from "node:test";
import { conversationActivity } from "../src/host/client/conversation-activity.ts";
import type { SessionView, ViewMessage } from "../src/host/client/pi-bridge.ts";

const session: SessionView = {
  schemaVersion: 1, sessionId: "activity", cwd: "/tmp", name: "Activity", model: "example/model",
  thinkingLevel: "off", thinkingLevels: ["off"], idle: true, contextUsage: null, messages: [], pluginEntries: [],
};
const stream = (blocks: ViewMessage["blocks"]): ViewMessage => ({ id: "stream", role: "assistant", timestamp: "2026-01-01", blocks });

test("bridges optimistic sending, backend work, and empty stream snapshots", () => {
  assert.equal(conversationActivity(session, null, "connected", true), "sending");
  const busy = { ...session, idle: false };
  assert.equal(conversationActivity(busy, null, "connected", false), "working");
  assert.equal(conversationActivity(busy, stream([]), "connected", false), "working");
  assert.equal(conversationActivity(busy, stream([{ kind: "text", text: "  " }]), "connected", false), "working");
  assert.equal(conversationActivity(busy, stream([{ kind: "thinking", text: "" }]), "connected", false), "working");
});

test("live answers, reasoning, and tool calls replace the placeholder", () => {
  for (const block of [
    { kind: "text" as const, text: "An answer" },
    { kind: "thinking" as const, text: "Reasoning" },
    { kind: "toolCall" as const, text: "", toolName: "bash", toolCallId: "call" },
  ]) assert.equal(conversationActivity({ ...session, idle: false }, stream([block]), "connected", false), null);
  // Committed history must not hide work between tool calls and the next response.
  assert.equal(conversationActivity({ ...session, idle: false, messages: [stream([{ kind: "text", text: "Previous answer" }])] }, null, "connected", false), "working");
});

test("completion, pause, errors, disconnection, and human-input waits do not animate", () => {
  assert.equal(conversationActivity(session, null, "connected", false), null);
  assert.equal(conversationActivity(null, null, "connected", true), null);
  assert.equal(conversationActivity({ ...session, idle: false }, null, "disconnected", true), null);
  assert.equal(conversationActivity({ ...session, idle: false }, { ...stream([]), error: "Failed" }, "connected", false), null);
  const interaction: NonNullable<SessionView["interactions"]>[number] = { requestId: "request", sessionId: session.sessionId, pluginId: "example", kind: "confirm", data: {} };
  assert.equal(conversationActivity({ ...session, idle: false, interactions: [interaction] }, null, "connected", false), null);
});
