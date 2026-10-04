import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { sessionsForWorkspace } from "../extension/sessions-for-workspace.ts";

test("unavailable workspace directories have an actionable error and recover when restored", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-missing-workspace-"));
  const project = join(root, "project");
  try {
    for (const path of [project, join(project, "child")]) {
      await assert.rejects(sessionsForWorkspace(path, []), { message: "工作区目录不可用，请恢复目录或从列表移除后重新添加" });
    }
    await writeFile(project, "not a directory");
    for (const path of [project, join(project, "child")]) {
      await assert.rejects(sessionsForWorkspace(path, []), { message: "工作区目录不可用，请恢复目录或从列表移除后重新添加" });
    }
    await rm(project);
    await mkdir(project);
    assert.deepEqual(await sessionsForWorkspace(project, []), []);
    await rm(project, { recursive: true });
    await symlink(project, project);
    await assert.rejects(sessionsForWorkspace(project, []), { code: "ELOOP" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sessions in colliding Pi storage directories stay with their actual workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-session-collision-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  try {
    const firstPath = join(root, "a-b", "c");
    const secondPath = join(root, "a", "b-c");
    await Promise.all([mkdir(firstPath, { recursive: true }), mkdir(secondPath, { recursive: true })]);
    const first = await realpath(firstPath);
    const second = await realpath(secondPath);
    const firstSession = SessionManager.create(first);
    firstSession.appendMessage({ role: "user", content: "first", timestamp: Date.now() });
    firstSession.appendMessage({ role: "assistant", content: [{ type: "text", text: "reply" }], timestamp: Date.now() } as Parameters<SessionManager["appendMessage"]>[0]);
    const secondSession = SessionManager.create(second);
    secondSession.appendMessage({ role: "user", content: "second", timestamp: Date.now() + 1000 });
    secondSession.appendMessage({ role: "assistant", content: [{ type: "text", text: "reply" }], timestamp: Date.now() + 1000 } as Parameters<SessionManager["appendMessage"]>[0]);

    assert.equal(firstSession.getSessionDir(), secondSession.getSessionDir());
    assert.equal((await SessionManager.list(first)).length, 2);
    assert.deepEqual((await sessionsForWorkspace(first)).map((session) => session.id), [firstSession.getSessionId()]);
    assert.deepEqual((await sessionsForWorkspace(await realpath(second))).map((session) => session.id), [secondSession.getSessionId()]);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});
