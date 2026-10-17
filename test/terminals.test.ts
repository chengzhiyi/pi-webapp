import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TerminalRegistry } from "../extension/terminals.ts";

async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) { if (Date.now() > deadline) throw new Error("Timed out waiting for shell"); await new Promise(resolve => setTimeout(resolve, 20)); }
}

test("PTY retains one session shell, streams output, resizes, interrupts and exits", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-pty-"));
  const registry = new TerminalRegistry({ shell: "/bin/bash", shellArgs: ["--noprofile", "--norc", "-i"] });
  try {
    const terminal = registry.create("terminal-a", "session-a", cwd, 80, 24);
    assert.equal(registry.create("terminal-a", "session-a", cwd, 80, 24), terminal);
    assert.throws(() => registry.get("terminal-a", "session-b"));
    let output = "";
    const detach = await terminal.attach(frame => { if (frame.type === "output") output += frame.data; return true; });
    terminal.write("printf 'PWD:%s\\n' \"$PWD\"\r");
    await until(() => output.includes(`PWD:${cwd}`));
    terminal.resize(91, 31);
    terminal.write("stty size\r");
    await until(() => output.includes("31 91"));
    terminal.write("sleep 30\r");
    await new Promise(resolve => setTimeout(resolve, 100));
    terminal.write("\x03");
    terminal.write("printf 'INTERRUPT_OK\\n'\r");
    await until(() => output.includes("\r\nINTERRUPT_OK"));
    detach();
    terminal.write("printf 'DETACHED_OK\\n'\r");
    await new Promise(resolve => setTimeout(resolve, 100));
    let snapshot = "";
    let exit: number | undefined;
    await terminal.attach(frame => { if (frame.type === "snapshot") snapshot = frame.screen; if (frame.type === "exit") exit = frame.exitCode; return true; });
    assert.match(snapshot, /DETACHED_OK/);
    terminal.write("exit 7\r");
    await until(() => exit === 7);
    assert.throws(() => terminal.write("echo should not run\r"));
  } finally { await registry.close(); await rm(cwd, { recursive: true, force: true }); }
});

test("closing and service shutdown reap running shells; launch failures leave no instance", async () => {
  const registry = new TerminalRegistry({ shell: "/bin/bash", shellArgs: ["--noprofile", "--norc", "-i"] });
  const first = registry.create("first", "a", tmpdir(), 80, 24);
  const second = registry.create("second", "a", tmpdir(), 80, 24);
  const pid = first.pid;
  await registry.remove("first", "a");
  assert.throws(() => process.kill(pid, 0));
  await registry.close();
  assert.throws(() => process.kill(second.pid, 0));
  assert.throws(() => registry.create("third", "a", tmpdir(), 80, 24));
  const bad = new TerminalRegistry({ shell: "/no/such/shell" });
  assert.throws(() => bad.create("bad", "a", tmpdir(), 80, 24));
  assert.throws(() => bad.get("bad", "a"));
  await bad.close();
});
