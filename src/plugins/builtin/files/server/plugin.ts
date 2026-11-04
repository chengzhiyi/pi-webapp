import type { ServerPlugin } from "../../../../host/server/plugins/server-plugin.ts";
import { metadata } from "../contract/manifest.ts";
import { listWorkspaceFiles, previewWorkspaceFile, readWorkspaceImage, writeWorkspaceFile, WorkspaceFileError } from "./workspace-files.ts";
import { searchWorkspaceFiles, workspaceFileStatus } from "./workspace-search.ts";
import { opaqueError } from "../../../../contracts/telemetry.ts";

export const filesPlugin: ServerPlugin = {
  metadata,
  routes: ["/api/workspace/files/list", "/api/workspace/files/preview", "/api/workspace/files/raw", "/api/workspace/files/write", "/api/workspace/files/status", "/api/workspace/files/search"],
  async handle({ path, body, snapshot, json, res }) {
    const session = snapshot();
    if (body.sessionId !== session.sessionId) { json(409, { error: "会话已切换" }); return; }
    const operation = path.slice(path.lastIndexOf("/") + 1);
    const pathless = operation === "status" || operation === "search";
    if (!pathless && (typeof body.path !== "string" || body.path.length > 4096)) { json(400, { error: "工作区文件路径无效" }); return; }
    const filePath = body.path as string;
    const switched = () => { const current = snapshot(); return current.sessionId !== session.sessionId || current.cwd !== session.cwd; };
    try {
      if (operation === "raw") {
        const image = await readWorkspaceImage(session.cwd, filePath);
        if (switched()) { json(409, { error: "会话已切换" }); return; }
        res.writeHead(200, { "Content-Type": image.mimeType, "Content-Length": image.bytes.length, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
        res.end(image.bytes);
        return;
      }
      // A write never lands in a workspace the user has since switched away from.
      if (operation === "write" && switched()) { json(409, { error: "会话已切换" }); return; }
      const value = operation === "list" ? await listWorkspaceFiles(session.cwd, filePath)
        : operation === "write" ? await writeWorkspaceFile(session.cwd, filePath, body.text, body.version)
        : operation === "status" ? await workspaceFileStatus(session.cwd)
        : operation === "search" ? await searchWorkspaceFiles(session.cwd, body.query, body.mode)
        : await previewWorkspaceFile(session.cwd, filePath);
      if (operation !== "write" && switched()) { json(409, { error: "会话已切换" }); return; }
      json(200, value);
    } catch (error) {
      if (error instanceof WorkspaceFileError) json(error.status, { error: error.message, errorCode: "validation_error", ...(error.reason ? { reason: error.reason } : {}) });
      else throw opaqueError(error, operation === "write" ? "工作区文件保存失败" : "工作区文件读取失败");
    }
  },
};
