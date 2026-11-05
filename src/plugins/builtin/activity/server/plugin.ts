import type { ServerResponse } from "node:http";
import type { ServerPlugin } from "../../../../host/server/plugins/server-plugin.ts";
import type { ActivitySource, ActivityTarget } from "../contract/activity.ts";
import { metadata } from "../contract/manifest.ts";

function target(body: Record<string, unknown>): ActivityTarget {
  if (typeof body.sessionId !== "string" || typeof body.id !== "string" || !body.id || body.id.length > 200 || (body.source !== "background-tasks" && body.source !== "subagents")) {
    throw new Error("Invalid activity target");
  }
  return { sessionId: body.sessionId, id: body.id, source: body.source as ActivitySource };
}

export function createActivityPlugin(): ServerPlugin {
  const streams = new Set<ServerResponse>();
  const clear = () => { for (const stream of streams) stream.end(); streams.clear(); };
  return {
    metadata,
    routes: ["snapshot", "attach", "detail", "stop", "rerun"].map(action => `/api/activity/${action}`),
    async handle({ path, body, activity, snapshot, res, json }) {
      if (!activity) { json(503, { error: "Activity is unavailable in this host", reason: "activity_unavailable" }); return; }
      if (body.sessionId !== snapshot().sessionId) { json(409, { error: "会话已切换" }); return; }
      if (path.endsWith("/snapshot")) { json(200, await activity.snapshot(body.sessionId)); return; }
      if (path.endsWith("/attach")) {
        let closed = false;
        let detach = () => {};
        const write = (value: unknown) => {
          if (closed) return;
          if (res.writableLength > 1024 * 1024) { res.destroy(); return; }
          res.write(`${JSON.stringify(value)}\n`);
        };
        res.once("close", () => { closed = true; detach(); streams.delete(res); });
        res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
        try {
          detach = activity.subscribe(body.sessionId, write);
          streams.add(res);
          write(await activity.snapshot(body.sessionId));
        } catch {
          detach(); streams.delete(res);
          if (!closed) res.end();
        }
        return;
      }
      let parsed: ActivityTarget;
      try { parsed = target(body); }
      catch { json(400, { error: "Invalid activity target" }); return; }
      if (path.endsWith("/detail")) { json(200, await activity.detail(parsed)); return; }
      if (path.endsWith("/stop")) { json(200, await activity.stop(parsed)); return; }
      if (path.endsWith("/rerun")) { json(200, await activity.rerun(parsed)); return; }
      json(404, { error: "Unknown activity operation" });
    },
    disable: async () => { clear(); },
    close: async () => { clear(); },
  };
}
