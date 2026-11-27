import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { identifySubagentSessions, readSubagentMessages } from "../src/host/server/sessions/subagent-sessions.ts";

const timestamp = "2026-01-01T00:00:00.000Z";
const agentId = "9b9f05c9-test";
const prompt = "Develop an acceptance test";
const instruction = "Use the preview branch";
const records = (...rows: unknown[]) => rows.map(row => JSON.stringify(row)).join("\n") + "\n";
const entry = (id: string, parentId: string | null, message: unknown) => ({ type: "message", id, parentId, timestamp, message });
const text = (value: string) => [{ type: "text", text: value }];
const toolCall = (id: string, name: string, args: unknown) => ({ type: "toolCall", id, name, arguments: args });

test("verifies the dispatch and message provenance without grouping same-name forks; keeps trashed-parent history reachable", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-sessions-"));
  try {
    const parent = join(root, "parent.jsonl"), child = join(root, "child.jsonl"), trash = join(root, "trash");
    const header = (id: string, parentSession?: string) => ({ type: "session", version: 3, id, timestamp, cwd: root, parentSession });
    const row = (path: string, id: string, parentSessionPath?: string, name?: string, firstMessage = prompt): SessionInfo => ({ path, id, cwd: root, name, parentSessionPath, created: new Date(timestamp), modified: new Date(timestamp), firstMessage, messageCount: 1, allMessagesText: "" });
    await writeFile(parent, records(header("parent"),
      entry("dispatch", null, { role: "assistant", content: [toolCall("agent-call", "Agent", { prompt, subagent_type: "general-purpose", description: "Write acceptance test" })] }),
      entry("spawn", "dispatch", { role: "toolResult", toolName: "Agent", toolCallId: "agent-call", content: text("Agent started"), details: { agentId, status: "background" } }),
      entry("steer", "spawn", { role: "assistant", content: [toolCall("steer-call", "steer_subagent", { agent_id: "e2e", message: instruction })] }),
      entry("sent", "steer", { role: "toolResult", toolName: "steer_subagent", toolCallId: "steer-call", content: text(`Steering message sent to agent ${agentId}.`) }),
    ));
    await writeFile(child, records(header("child", parent),
      entry("first", null, { role: "user", content: text(prompt) }),
      entry("second", "first", { role: "user", content: text(instruction) }),
      entry("other-branch", "first", { role: "user", content: text("Not on the current branch") }),
      entry("third", "second", { role: "user", content: text("Manually appended text") }),
    ));
    const childRow = row(child, "child", parent, "general-purpose#9b9f05c9");
    const rows = [row(parent, "parent"), childRow, row(join(root, "fork.jsonl"), "fork", parent, childRow.name, "Different first prompt"), row(join(root, "clone.jsonl"), "clone", child, childRow.name)];
    const running = await identifySubagentSessions(rows, trash, new Set(["parent"]));
    assert.deepEqual([...running.keys()], ["child"]);
    assert.deepEqual(running.get("child")?.view, { parentSessionId: "parent", agentId, agentType: "general-purpose", dispatchCallId: "agent-call", description: "Write acceptance test", status: "running" });
    assert.deepEqual((await readSubagentMessages(child, "child", running.get("child")!)).map(message => [message.id, message.subagentInput]), [["first", "dispatch"], ["second", "steering"], ["third", undefined]]);
    assert.equal((await identifySubagentSessions(rows, trash)).get("child")?.view.status, "unknown");
    await appendFile(parent, records({ type: "custom", customType: "subagents:record", data: { id: agentId, status: "completed" } }));
    assert.equal((await identifySubagentSessions(rows, trash)).get("child")?.view.status, "completed");
    await mkdir(trash);
    await rename(parent, join(trash, `123_${basename(parent)}`));
    assert.equal((await identifySubagentSessions([childRow], trash)).get("child")?.view.parentSessionId, null);
    assert.equal((await identifySubagentSessions([childRow], join(root, "unrelated"))).size, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
