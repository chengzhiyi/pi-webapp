import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);
const moduleUrl = new URL("../bin/launcher-logs.mjs", import.meta.url).href;
const script = `import { showLogs } from ${JSON.stringify(moduleUrl)};
await showLogs(process.argv[1], process.argv.slice(2));`;
const command = (path: string, args: string[]) => ["--input-type=module", "-e", script, "--", path, ...args];
const run = (path: string, ...args: string[]) => exec(process.execPath, command(path, args), { timeout: 5_000 });

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "pi-launcher-logs-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, "launcher.log");
}

test("logs defaults to 100 lines and preserves CRLF, blank lines, and an unterminated last line", async t => {
  const path = await fixture(t);
  const lines = Array.from({ length: 105 }, (_, i) => `日志 ${i}\r\n`);
  await writeFile(path, lines.join(""));
  assert.equal((await run(path)).stdout, lines.slice(-100).join(""));
  assert.equal((await run(path, "--tail=2")).stdout, lines.slice(-2).join(""));
  await appendFile(path, "\r\n未完成");
  assert.equal((await run(path, "--tail", "2")).stdout, "\r\n未完成");
  assert.equal((await run(path, "--tail", "0")).stdout, "");
  await writeFile(path, "");
  assert.equal((await run(path)).stdout, "");
});

test("logs redacts common credential forms without changing the original log", async t => {
  const path = await fixture(t);
  const original = [
    'ready: "http://127.0.0.1:3000/#fragment_secret"',
    "request: Bearer bearer.secret",
    'headers: {"Authorization":"bEaReR header-secret", "x-access-token": "access_secret"}',
    "Authorization: raw-secret",
    "url /app?token=query-secret&view=logs",
    "PI_WEBAPP_RESTART_TOKEN=restart-secret",
    "ordinary startup output",
  ].join("\n");
  await writeFile(path, original);
  const { stdout, stderr } = await run(path);
  assert.equal(stdout, original.replace(/fragment_secret|bearer\.secret|header-secret|access_secret|raw-secret|query-secret|restart-secret/g, "[REDACTED]"));
  assert.equal(stderr, "");
  assert.equal(await readFile(path, "utf8"), original);
});

test("logs rejects invalid options and does not create a missing log", async t => {
  const path = await fixture(t);
  for (const args of [["--tail"], ["--tail", "-1"], ["--tail=1.5"], ["--tail=9007199254740992"], ["--tail=2", "--tail=3"]]) {
    await assert.rejects(run(path, ...args), { stderr: /--tail/ });
  }
  await assert.rejects(run(path, "--unknown"), { stderr: /Unknown logs option/ });
  await assert.rejects(run(path), { stderr: /ENOENT/ });
  await assert.rejects(readFile(path), { code: "ENOENT" });
});

test("logs bounds its tail scan and drops a clipped line rather than exposing a credential suffix", async t => {
  const path = await fixture(t);
  await writeFile(path, `Bearer ${"x".repeat(4 * 1024 * 1024)}secret-suffix\nkept\n`);
  const { stdout, stderr } = await run(path, "--tail=2");
  assert.equal(stdout, "kept\n");
  assert.match(stderr, /4 MiB/);
});

test("logs --follow prints the tail and redacts a credential split across the initial read and an append", async t => {
  const path = await fixture(t);
  await writeFile(path, "old\nready\nAuthorization: Bear");
  const child = spawn(process.execPath, command(path, ["--follow", "--tail", "2"]), { stdio: ["ignore", "pipe", "pipe"] });
  const closed = once(child, "close");
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  const waitFor = async (text: string) => {
    const deadline = Date.now() + 5_000;
    while (!stdout.includes(text) && child.exitCode === null && Date.now() < deadline) await delay(20);
    assert.ok(stdout.includes(text), `missing ${JSON.stringify(text)} in ${JSON.stringify(stdout)}; stderr: ${stderr}`);
  };
  try {
    await waitFor("ready\n");
    assert.equal(stdout, "ready\n");
    await appendFile(path, "er appended-secret\r\n完成\n");
    await waitFor("完成\n");
    assert.equal(stdout, "ready\nAuthorization: Bearer [REDACTED]\r\n完成\n");
    await writeFile(path, "truncated\n");
    await waitFor("truncated\n");
    assert.equal(stdout, "ready\nAuthorization: Bearer [REDACTED]\r\n完成\ntruncated\n");
    assert.equal(stderr, "");
  } finally {
    child.kill();
    await closed;
  }
});
