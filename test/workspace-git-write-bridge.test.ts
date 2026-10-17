import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, realpath, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { startBridge } from "../extension/bridge.ts";
import { withGitWorktreeLease } from "../extension/workspace-git-write.ts";
import { terminalHost } from "./helpers/terminal-host.ts";
import { isContentOperation, safeFields } from "../shared/telemetry.ts";

test("Git writes authenticate, check selection and all running chats, reject leases, and preserve unstaged content", async t => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "pi-git-write-api-"))); t.after(() => rm(cwd, { recursive: true, force: true }));
  const git = async (...args: string[]) => (await promisify(execFile)("git", args, { cwd })).stdout.trim();
  await git("init", "-b", "main"); await git("config", "user.name", "API Test"); await git("config", "user.email", "test@example.invalid"); await git("config", "commit.gpgsign", "false");
  await writeFile(join(cwd, "file.txt"), "staged\n");
  const { host } = terminalHost(cwd);
  const snapshot = host.snapshot;
  let busy: string[] = [];
  host.busyGitWorkspaces = () => busy;
  let sends = 0; host.send = () => { sends++; };
  const bridge = await startBridge(host, fileURLToPath(new URL("../web/dist/", import.meta.url))); t.after(() => bridge.close());
  const url = new URL(bridge.url);
  const headers = { Authorization: `Bearer ${url.hash.slice(1)}`, "Content-Type": "application/json", Origin: url.origin };
  const request = (route: string, body: object = {}, selected = headers) => fetch(`${url.origin}/api/workspace/git/${route}`, { method: "POST", headers: selected, body: JSON.stringify({ sessionId: "terminal-a", ...body }) });
  const control = async () => (await request("control")).json();
  const write = async (body: object) => request("write", { expected: (await control()).version, ...body });
  for (const route of ["control", "write"]) {
    assert.equal((await request(route, {}, { ...headers, Authorization: "" })).status, 401);
    assert.equal((await request(route, {}, { ...headers, Origin: "https://other.example" })).status, 403);
    assert.equal((await request(route, { sessionId: "stale" })).status, 409);
    assert.equal(isContentOperation(`/api/workspace/git/${route}`), true);
    assert.equal(safeFields({ route: `/api/workspace/git/${route}` }).route, `/api/workspace/git/${route}`);
  }
  assert.equal((await write({ action: "reset", path: "file.txt" })).status, 400);
  busy = [join(cwd, "child")]; assert.equal((await control()).blocked, "agent_busy");
  let response = await write({ action: "stage", path: "file.txt" }); assert.equal(response.status, 409); assert.equal((await response.json()).reason, "agent_busy");
  busy = [join(cwd, "..", "unrelated-worktree")]; assert.equal((await control()).blocked, null);
  let reads = 0;
  host.snapshot = () => ++reads < 4 ? snapshot() : { ...snapshot(), sessionId: "changed" };
  response = await request("write", { action: "stage", path: "file.txt", expected: (await (await import("../extension/workspace-git-write.ts")).workspaceGitControl(cwd)).version });
  assert.equal(response.status, 409); assert.equal((await response.json()).reason, "session_changed"); assert.equal(await git("ls-files"), ""); host.snapshot = snapshot;
  let release!: () => void; let acquired!: () => void;
  const ready = new Promise<void>(yes => { acquired = yes; });
  const lease = withGitWorktreeLease(cwd, async () => { acquired(); await new Promise<void>(yes => { release = yes; }); }); await ready;
  try {
    response = await write({ action: "stage", path: "file.txt" }); assert.equal((await response.json()).reason, "busy");
    const message = await fetch(`${url.origin}/api/message`, { method: "POST", headers, body: JSON.stringify({ sessionId: "terminal-a", text: "start" }) });
    assert.equal(message.status, 409); assert.equal((await message.json()).reason, "busy"); assert.equal(sends, 0);
  } finally { release(); await lease; }
  response = await write({ action: "stage", path: "file.txt" }); assert.equal(response.status, 200);
  const expected = (await control()).version; await writeFile(join(cwd, "file.txt"), "working\n");
  response = await request("write", { expected, action: "commit", message: "stale" }); assert.equal((await response.json()).reason, "state_changed");
  response = await write({ action: "commit", message: "staged only" }); assert.equal(response.status, 200); assert.equal(await git("show", "HEAD:file.txt"), "staged");
  assert.equal(await readFile(join(cwd, "file.txt"), "utf8"), "working\n");
  // Switching the foreground chat during an already-running hook cannot undo a commit.
  // The response must acknowledge the completed operation in its original chat.
  assert.equal((await write({ action: "stage", path: "file.txt" })).status, 200);
  const hook = join(cwd, ".git/hooks/pre-commit");
  await writeFile(hook, "#!/bin/sh\ntouch .git/hook-started\nwhile ! test -e .git/hook-release; do sleep 0.02; done\n"); await chmod(hook, 0o755);
  const committing = write({ action: "commit", message: "completed during switch" });
  try {
    const deadline = Date.now() + 4000;
    while (true) {
      try { await readFile(join(cwd, ".git/hook-started")); break; }
      catch { assert.ok(Date.now() < deadline, "commit hook started"); await new Promise(yes => setTimeout(yes, 20)); }
    }
    host.snapshot = () => ({ ...snapshot(), sessionId: "changed" });
  } finally { await writeFile(join(cwd, ".git/hook-release"), "release"); }
  response = await committing; assert.equal(response.status, 200); assert.equal((await response.json()).action, "commit");
  assert.equal(await git("log", "-1", "--format=%s"), "completed during switch");
});
