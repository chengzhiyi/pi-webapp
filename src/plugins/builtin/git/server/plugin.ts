import { isAbsolute, relative } from "node:path";
import type { ServerPlugin } from "../../../../host/server/plugins/server-plugin.ts";
import { metadata } from "../contract/manifest.ts";
import { WorkspaceGitError } from "./git-command.ts";
import { workspaceGitWrite, withGitWorktreeLease } from "./workspace-git-write.ts";
import { workspaceGitRequest, workspaceGitRoutes } from "./workspace-git-request.ts";
import { WorkspaceFileError } from "../../files/server/public.ts";
import type { GitControlState } from "../contract/workspace-git.ts";
import { opaqueError } from "../../../../contracts/telemetry.ts";

export const gitPlugin: ServerPlugin = {
  metadata, routes: workspaceGitRoutes,
  coordinateStart: (cwd, operation) => withGitWorktreeLease(cwd, operation, true),
  requestFailure: error => error instanceof WorkspaceGitError ? { status: error.status, body: { error: error.message, errorCode: "validation_error", reason: error.reason } } : null,
  async handle({ path, body, snapshot, busyWorkspaces, json }) {
    const session = snapshot();
    if (body.sessionId !== session.sessionId) { json(409, { error: "会话已切换" }); return; }
    try {
      const busy = (root: string) => !snapshot().idle || busyWorkspaces().some(cwd => {
        const inside = (a: string, b: string) => { const p = relative(a, b); return p !== ".." && !p.startsWith("../") && !p.startsWith("..\\") && !isAbsolute(p); };
        return inside(root, cwd) || inside(cwd, root);
      });
      const guard = (root: string) => {
        const current = snapshot();
        if (current.sessionId !== session.sessionId || current.cwd !== session.cwd) throw new WorkspaceGitError("会话已切换", 409, "session_changed");
        if (busy(root)) throw new WorkspaceGitError("共用此工作树的聊天正在运行", 409, "agent_busy");
      };
      const writing = path.endsWith("/write");
      const value = writing ? await workspaceGitWrite(session.cwd, body, guard) : await workspaceGitRequest(path, session.cwd, body);
      if (!writing) {
        const current = snapshot();
        if (current.sessionId !== session.sessionId || current.cwd !== session.cwd) { json(409, { error: "会话已切换" }); return; }
        if (path.endsWith("/control")) {
          const control = value as GitControlState;
          if (control.root && busy(control.root)) control.blocked ??= "agent_busy";
        }
      }
      json(200, value);
    } catch (error) {
      if (error instanceof WorkspaceGitError || error instanceof WorkspaceFileError) json(error.status, { error: error.message, errorCode: "validation_error", ...(error instanceof WorkspaceGitError ? { reason: error.reason } : {}) });
      else throw opaqueError(error, "Git 操作失败");
    }
  },
};
