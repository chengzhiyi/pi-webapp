import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TerminalRegistry } from "../src/plugins/builtin/terminal/server/terminals.ts";

async function query(attachedBrowser: boolean) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-terminal-query-"));
  const first = join(cwd, "reply"), extra = join(cwd, "extra"), done = join(cwd, "done");
  const registry = new TerminalRegistry({ shell: "/bin/sh", shellArgs: ["-c",
    'sleep 0.1; stty -echo -icanon min 1 time 0; printf "\\033[6n"; dd bs=1 count=6 2>/dev/null > "$1"; stty min 0 time 2; dd bs=1 count=6 2>/dev/null > "$2"; printf done > "$3"',
    "probe", first, extra, done] });
  try {
    const terminal = registry.create("query", "session", cwd, 80, 24);
    if (attachedBrowser) await terminal.attach(frame => {
      if (frame.type === "output" && frame.data.includes("\x1b[6n")) terminal.write("\x1b[1;1R");
      return true;
    });
    const deadline = Date.now() + 7000;
    while (true) {
      try { if (await readFile(done, "utf8") === "done") break; } catch {}
      if (Date.now() > deadline) throw new Error("terminal query handshake timed out");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(await readFile(first, "utf8"), "\x1b[1;1R");
    assert.equal(await readFile(extra, "utf8"), "", "never send a second reply on top of the attached browser");
  } finally { await registry.close(); await rm(cwd, { recursive: true, force: true }); }
}

test("headless terminal answers device queries while no browser is attached", { skip: process.platform === "win32" }, () => query(false));
test("attached browser owns device replies without duplicate headless responses", { skip: process.platform === "win32" }, () => query(true));
