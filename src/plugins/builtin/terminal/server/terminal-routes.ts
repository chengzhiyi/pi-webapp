import type { ServerResponse } from "node:http";
import type { SessionView } from "../../../../host/server/sessions/view.ts";
import { TerminalLaunchError, TerminalRegistry } from "./terminals.ts";
import { validTerminalSize } from "../contract/terminal.ts";

/** Called only after the bridge has checked bearer auth, origin, JSON and sessionId. */
export async function terminalRoute(path: string, body: { sessionId: string } & Record<string, unknown>, res: ServerResponse, snapshot: () => SessionView, registry: TerminalRegistry, streams: Set<ServerResponse>) {
  const reply = (status: number, value: object) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(value)); };
  if (typeof body.id !== "string" || !/^[a-f0-9-]{36}$/i.test(body.id)) { reply(400, { error: "终端标识无效" }); return; }
  const action = path.slice("/api/terminal/".length);
  // Closing an owned inactive terminal is allowed, so late tab cleanup cannot leak processes.
  const session = snapshot();
  if (action !== "close" && body.sessionId !== session.sessionId) { reply(409, { error: "会话已切换" }); return; }
  if ((action === "create" || action === "resize") && !validTerminalSize(body.cols, body.rows)) { reply(400, { error: "终端尺寸无效" }); return; }
  if (action === "input" && (typeof body.data !== "string" || Buffer.byteLength(body.data) > 16_384)) { reply(400, { error: "终端输入无效或过大" }); return; }
  try {
    if (action === "create") { registry.create(body.id, body.sessionId, session.cwd, body.cols as number, body.rows as number); reply(201, { id: body.id }); return; }
    if (action === "close") { await registry.remove(body.id, body.sessionId); reply(200, { closed: true }); return; }
    const terminal = registry.get(body.id, body.sessionId);
    if (action === "attach") {
      let closed = false;
      let detach: (() => void) | undefined;
      res.once("close", () => { closed = true; detach?.(); streams.delete(res); });
      detach = await terminal.attach(frame => {
        if (closed) return false;
        if (!res.headersSent) res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
        if (res.writableLength > 1024 * 1024) { res.destroy(); return false; }
        res.write(`${JSON.stringify(frame)}\n`);
        return true;
      });
      if (closed) detach(); else streams.add(res);
      return;
    }
    if (action === "input") terminal.write(body.data as string);
    else if (action === "resize") terminal.resize(body.cols as number, body.rows as number);
    else { reply(404, { error: "未知终端操作" }); return; }
    reply(200, { accepted: true });
  } catch (error) {
    if (!res.headersSent) reply(400, {
      error: error instanceof TerminalLaunchError ? error.message : action === "create" ? "本机终端组件启动失败，请重新安装或修复应用的终端依赖" : "终端不可用或不属于此会话，请重新打开终端",
      reason: error instanceof TerminalLaunchError ? error.reason : action === "create" ? "terminal_runtime_unavailable" : undefined,
    });
    else res.end();
  }
}
