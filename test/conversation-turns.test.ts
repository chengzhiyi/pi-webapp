import assert from "node:assert/strict";
import test from "node:test";
import { conversationTurns, toolResults } from "../web/src/conversation-turns.ts";
import { projectEntry, sessionTitle } from "../extension/view.ts";
import type { ViewMessage } from "../web/src/pi-bridge.ts";

test("projects Pi calls, results, and reported assistant usage", () => {
  const assistant = projectEntry({ id: "a", type: "message", timestamp: "2026-01-01T00:00:00Z", parentId: null,
    message: { role: "assistant", timestamp: 0, content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "pwd" } }],
      usage: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, reasoning: 1, totalTokens: 14,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } },
      api: "openai-responses", provider: "test", model: "test", stopReason: "toolUse" },
  } as Parameters<typeof projectEntry>[0]);
  const result = projectEntry({ id: "r", type: "message", timestamp: "2026-01-01T00:00:01Z", parentId: "a",
    message: { role: "toolResult", timestamp: 1, toolCallId: "call-1", toolName: "bash", isError: false,
      content: [{ type: "text", text: "/tmp" }] },
  } as Parameters<typeof projectEntry>[0]);
  assert.equal(assistant?.blocks[0]?.toolCallId, "call-1");
  assert.equal(assistant?.usage?.totalTokens, 14);
  assert.equal(result?.toolCallId, "call-1");
});

test("preserves a failed assistant response even when it has no text or tokens", () => {
  const failed = projectEntry({ id: "failed", type: "message", timestamp: "2026-01-01T00:00:00Z", parentId: null,
    message: { role: "assistant", timestamp: 0, content: [], api: "openai-codex-responses", provider: "openai-codex", model: "gpt-5.5",
      stopReason: "error", errorMessage: "Codex error: The usage limit has been reached",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    },
  } as Parameters<typeof projectEntry>[0]);
  assert.equal(failed?.error, "Codex error: The usage limit has been reached");
  assert.deepEqual(failed?.blocks, []);
});

test("keeps turn usage separate and pairs only matching tool results", () => {
  const messages: ViewMessage[] = [
    { id: "u1", role: "user", timestamp: "2026-01-01", blocks: [{ kind: "text", text: "Inspect" }] },
    { id: "a1", role: "assistant", timestamp: "2026-01-01", blocks: [{ kind: "toolCall", toolCallId: "call-1", toolName: "bash", text: "{}" }],
      usage: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, totalTokens: 14, cost: 0.01 } },
    { id: "r1", role: "tool", timestamp: "2026-01-01", toolCallId: "call-1", blocks: [{ kind: "text", text: "done" }] },
    { id: "r2", role: "tool", timestamp: "2026-01-01", toolCallId: "orphan", blocks: [{ kind: "text", text: "orphan" }] },
    { id: "a2", role: "assistant", timestamp: "2026-01-01", blocks: [{ kind: "text", text: "Done" }],
      usage: { input: 7, output: 8, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: 0.02 } },
    { id: "u2", role: "user", timestamp: "2026-01-01", blocks: [{ kind: "text", text: "Next" }] },
  ];
  const turns = conversationTurns(messages);
  assert.equal(turns.length, 2);
  assert.deepEqual(turns[0]?.usage, { input: 9, output: 11, cacheRead: 4, cacheWrite: 5, totalTokens: 29, cost: 0.03 });
  assert.equal(turns[1]?.usage, null);
  assert.equal(toolResults(messages).get("call-1")?.id, "r1");
  assert.equal(toolResults(messages).has("orphan"), false);
  assert.equal(sessionTitle(undefined, messages), "Inspect");
  assert.equal(sessionTitle("  Named  ", messages), "Named");
  assert.equal(sessionTitle(undefined, [{ id: "attachment", role: "user", timestamp: "2026-01-01", blocks: [
    { kind: "text", text: `图片内容\n\n附件 "图片.png"：/tmp/pi-web/attachments/${"a".repeat(64)}/图片.png` },
  ] }]), "图片内容");
});
