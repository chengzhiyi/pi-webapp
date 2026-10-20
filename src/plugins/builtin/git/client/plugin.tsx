import { defineWebPlugin } from "@chengzhiyi/pi-web-protocol";
import type { WorkbenchPluginDefinition } from "../../../../contracts/workbench.ts";
import { IconBranchOutlineRegular } from "../../../../../web/src/ui/shared/primitives/icons/index.tsx";
import { WorkspaceGit } from "./WorkspaceGit.tsx";
import { WorkspaceGitCommit, WorkspaceGitCommitDiff } from "./WorkspaceGitCommit.tsx";
import { WorkspaceGitDiff } from "./WorkspaceGitDiff.tsx";
import { createGitPanelModel } from "./git-panel-model.ts";
import type { GitDiffArea } from "../contract/workspace-git.ts";
import { metadata } from "../contract/manifest.ts";

export default defineWebPlugin<WorkbenchPluginDefinition>({
  id: metadata.id, apiVersion: 1, activate() {},
  workbench: {
    apiVersion: 1,
    entry: { label: { zh: "Git 改动", en: "Git changes" }, description: { zh: "查看分支、工作区改动与文件差异", en: "Review branches, workspace changes and file diffs" }, kind: "git", icon: IconBranchOutlineRegular },
    panels: [
      { kind: "git", title: () => <><IconBranchOutlineRegular size={16} /><span>Git</span></>, component: p => <WorkspaceGit sessionId={p.session.sessionId} visible={p.visible} idle={p.session.idle} model={p.resource(createGitPanelModel)} onCommit={hash => p.open("git-commit", hash, hash.slice(0, 7))} /> },
      { kind: "git-commit", component: p => <WorkspaceGitCommit sessionId={p.session.sessionId} hash={p.contentId} visible={p.visible} idle={p.session.idle} onCommit={hash => p.open("git-commit", hash, hash.slice(0, 7))} /> },
      { kind: "git-diff", component: p => { const [area, path] = JSON.parse(p.contentId) as [GitDiffArea, string]; return <WorkspaceGitDiff sessionId={p.session.sessionId} area={area} path={path} visible={p.visible} idle={p.session.idle} />; } },
      { kind: "git-commit-diff", component: p => { const [hash, parentIndex, path] = JSON.parse(p.contentId) as [string, number, string]; return <WorkspaceGitCommitDiff sessionId={p.session.sessionId} hash={hash} parentIndex={parentIndex} path={path} visible={p.visible} idle={p.session.idle} />; } },
    ],
  },
});
