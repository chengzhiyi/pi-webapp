import { accessSync, constants, statSync } from "node:fs";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import type { IPty } from "node-pty";
import type { Terminal as HeadlessTerminal } from "@xterm/headless";
import type { SerializeAddon as Serializer } from "@xterm/addon-serialize";
import type { TerminalFrame } from "../contract/terminal.ts";

// Native/CJS dependencies must resolve beside the installed extension, including its bundled build.
const require = createRequire(import.meta.url);
type Follower = (frame: TerminalFrame) => boolean;

/** The shell and screen outlive browser components and short network interruptions. */
export class SessionTerminal {
  readonly pid: number;
  private readonly pty: IPty;
  private readonly screen: HeadlessTerminal;
  private readonly serializer: Serializer;
  private readonly followers = new Set<Follower>();
  private pending = Promise.resolve();
  private exit: Extract<TerminalFrame, { type: "exit" }> | undefined;
  private disposed = false;
  private readonly done: Promise<void>;
  private expire: ReturnType<typeof setTimeout> | undefined;
  private closing: Promise<void> | undefined;

  readonly sessionId: string;
  private readonly abandoned: () => void;
  private readonly graceMs: number;
  constructor(sessionId: string, cwd: string, cols: number, rows: number, shell: string, args: string[], abandoned: () => void, graceMs: number) {
    this.sessionId = sessionId; this.abandoned = abandoned; this.graceMs = graceMs;
    const { Terminal } = require("@xterm/headless") as typeof import("@xterm/headless");
    const { SerializeAddon } = require("@xterm/addon-serialize") as typeof import("@xterm/addon-serialize");
    this.screen = new Terminal({ cols, rows, scrollback: 2000, allowProposedApi: true });
    this.serializer = new SerializeAddon();
    this.screen.loadAddon(this.serializer);
    // Never copy the web access/restart token into an interactive process.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !/^PI_WEBAPP_RESTART_/.test(key))) as Record<string, string>;
    try { this.pty = (require("node-pty") as typeof import("node-pty")).spawn(shell, args, { name: "xterm-256color", cwd, cols, rows, env: { ...env, TERM: "xterm-256color", COLORTERM: "truecolor" } }); }
    catch (error) { this.screen.dispose(); throw error; }
    this.pid = this.pty.pid;
    this.pty.onData(data => {
      if (this.disposed) return;
      this.pty.pause();
      this.pending = this.pending.then(() => new Promise<void>(resolve => {
        if (this.disposed) { resolve(); return; }
        this.screen.write(data, () => { this.broadcast({ type: "output", data }); resolve(); });
      })).finally(() => { if (!this.exit && !this.disposed) this.pty.resume(); });
    });
    this.done = new Promise(resolve => this.pty.onExit(({ exitCode, signal }) => {
      this.exit = { type: "exit", exitCode, signal };
      void this.pending.then(() => { this.broadcast(this.exit!); resolve(); });
    }));
    this.scheduleExpiry();
  }

  private broadcast(frame: TerminalFrame) {
    for (const follower of this.followers) if (!follower(frame)) this.followers.delete(follower);
    if (!this.followers.size) this.scheduleExpiry();
  }
  private scheduleExpiry() {
    if (this.expire || this.disposed) return;
    this.expire = setTimeout(this.abandoned, this.graceMs).unref();
  }
  async attach(send: Follower): Promise<() => void> {
    await this.pending;
    if (this.disposed) throw new Error("终端已关闭");
    clearTimeout(this.expire); this.expire = undefined;
    if (send({ type: "snapshot", screen: this.serializer.serialize(), cols: this.screen.cols, rows: this.screen.rows })) {
      if (this.exit) send(this.exit);
      this.followers.add(send);
    } else this.scheduleExpiry();
    return () => { this.followers.delete(send); if (!this.followers.size) this.scheduleExpiry(); };
  }
  write(data: string) {
    if (this.exit || this.disposed) throw new Error("终端已退出");
    this.pty.write(data);
  }
  resize(cols: number, rows: number) {
    if (this.exit || this.disposed) return;
    this.pty.resize(cols, rows);
    this.pending = this.pending.then(() => {
      if (this.disposed) return;
      this.screen.resize(cols, rows); this.broadcast({ type: "resize", cols, rows });
    });
  }
  close(): Promise<void> { return this.closing ??= this.dispose(); }
  private async dispose() {
    this.disposed = true;
    clearTimeout(this.expire);
    if (!this.exit) {
      // Kill shell jobs as well as the shell. Job control may place children in separate groups.
      if (process.platform === "win32") await new Promise<void>(resolve => execFile("taskkill", ["/pid", String(this.pid), "/T", "/F"], () => resolve()));
      else {
        const descendants = await new Promise<string>(resolve => execFile("ps", ["-axo", "pid=,ppid="], (error, stdout) => resolve(error ? "" : stdout)));
        const children = descendants.trim().split("\n").map(line => line.trim().split(/\s+/).map(Number));
        const collect = (parent: number): number[] => children.filter(([, ppid]) => ppid === parent).flatMap(([pid]) => [...collect(pid), pid]);
        for (const pid of [...collect(this.pid), this.pid]) { try { process.kill(pid, "SIGKILL"); } catch {} }
      }
      this.pty.kill();
      this.pty.resume();
      await this.done;
    }
    await this.pending;
    this.followers.clear();
    this.screen.dispose();
  }
}

export class TerminalRegistry {
  private readonly terminals = new Map<string, SessionTerminal>();
  private stopped = false;
  private readonly options: { shell?: string; shellArgs?: string[]; graceMs?: number };
  constructor(options: { shell?: string; shellArgs?: string[]; graceMs?: number } = {}) { this.options = options; }
  create(id: string, sessionId: string, cwd: string, cols: number, rows: number) {
    if (this.stopped) throw new Error("终端服务已停止");
    if (this.terminals.has(id)) return this.get(id, sessionId);
    if (this.terminals.size >= 32 || [...this.terminals.values()].filter(item => item.sessionId === sessionId).length >= 8) throw new Error("终端数量已达上限，请关闭不用的终端");
    const shell = this.options.shell ?? (process.platform === "win32" ? process.env.COMSPEC || "cmd.exe" : process.env.SHELL || "/bin/sh");
    accessSync(shell, constants.X_OK);
    if (!statSync(cwd).isDirectory()) throw new Error("工作区目录不可用");
    const args = this.options.shellArgs ?? (process.platform === "win32" ? [] : ["-i"]);
    const terminal = new SessionTerminal(sessionId, cwd, cols, rows, shell, args, () => { void this.remove(id, sessionId); }, this.options.graceMs ?? 5 * 60_000);
    this.terminals.set(id, terminal);
    return terminal;
  }
  get(id: string, sessionId: string) {
    const terminal = this.terminals.get(id);
    if (!terminal || terminal.sessionId !== sessionId) throw new Error("终端不存在或不属于此会话");
    return terminal;
  }
  async remove(id: string, sessionId: string) {
    const terminal = this.terminals.get(id);
    if (!terminal) return;
    if (terminal.sessionId !== sessionId) throw new Error("终端不属于此会话");
    await terminal.close();
    if (this.terminals.get(id) === terminal) this.terminals.delete(id);
  }
  async clear() { await Promise.all([...this.terminals.values()].map(item => item.close())); this.terminals.clear(); }
  async close() { this.stopped = true; await this.clear(); }
}
