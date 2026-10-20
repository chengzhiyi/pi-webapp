import { defineWebPlugin } from "@chengzhiyi/pi-web-protocol";
import type { WorkbenchPluginDefinition } from "../../../../contracts/workbench.ts";
import { FileTypeIcon } from "../../../../../web/src/ui/primitives/FileTypeIcon.tsx";
import { metadata } from "../contract/manifest.ts";
import { WorkspaceFiles, createWorkspaceTree } from "./WorkspaceFiles.tsx";
import { WorkspaceFilePreview } from "./WorkspaceFilePreview.tsx";

export default defineWebPlugin<WorkbenchPluginDefinition>({
  id: metadata.id, apiVersion: 1, activate() {},
  workbench: {
    apiVersion: 1,
    entry: { label: metadata.name, panelTitle: { zh: "文件", en: "Files" }, description: { zh: "浏览当前会话的文件并打开预览", en: "Browse this session’s files and open previews" }, kind: "files", icon: ({ size }) => <FileTypeIcon kind="folder" size={size} /> },
    panels: [
      { kind: "files", component: p => <WorkspaceFiles sessionId={p.session.sessionId} cwd={p.session.cwd} state={p.resource(createWorkspaceTree)} onOpen={path => p.open("file-preview", path, path.split("/").at(-1)!)} /> },
      { kind: "file-preview", title: (path, title) => <><FileTypeIcon path={path} size={16} /><span>{title}</span></>, component: p => <WorkspaceFilePreview sessionId={p.session.sessionId} path={p.contentId} renderMarkdown={p.renderMarkdown} /> },
    ],
  },
});
