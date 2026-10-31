import type { ServerPlugin } from "../../../../host/server/plugins/server-plugin.ts";
import { metadata } from "../contract/manifest.ts";
import { listWorkspaceFiles, previewWorkspaceFile, readWorkspaceImage, WorkspaceFileError } from "./workspace-files.ts";
import { opaqueError } from "../../../../contracts/telemetry.ts";

export const filesPlugin: ServerPlugin = {
  metadata, routes: ["/api/workspace/files/list", "/api/workspace/files/preview", "/api/workspace/files/raw"],
  async handle({ path, body, snapshot, json, res }) {
    const session = snapshot();
    if (body.sessionId !== session.sessionId) { json(409, { error: "会话已切换" }); return; }
    if (typeof body.path !== "string" || body.path.length > 4096) { json(400, { error: "工作区文件路径无效" }); return; }
    try {
      if (path.endsWith("/raw")) {
        const image = await readWorkspaceImage(session.cwd, body.path);
        const current = snapshot();
        if (current.sessionId !== session.sessionId || current.cwd !== session.cwd) { json(409, { error: "会话已切换" }); return; }
        res.writeHead(200, { "Content-Type": image.mimeType, "Content-Length": image.bytes.length, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
        res.end(image.bytes);
        return;
      }
      const value = path.endsWith("/list") ? await listWorkspaceFiles(session.cwd, body.path) : await previewWorkspaceFile(session.cwd, body.path);
      const current = snapshot();
      if (current.sessionId !== session.sessionId || current.cwd !== session.cwd) { json(409, { error: "会话已切换" }); return; }
      json(200, value);
    } catch (error) {
      if (error instanceof WorkspaceFileError) json(error.status, { error: error.message, errorCode: "validation_error" });
      else throw opaqueError(error, "工作区文件读取失败");
    }
  },
};
