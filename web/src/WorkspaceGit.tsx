import { memo, useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { GitDiffArea, GitFileChange, GitWriteAction } from "../../shared/workspace-git.ts";
import { FileTypeIcon } from "./ui/primitives/FileTypeIcon.tsx";
import { IconRefreshOutlineRegular } from "./ui/shared/primitives/icons/index.tsx";
import { localize as t, useLocale } from "./ui/locale/preference.ts";
import { observeComposition } from "./ui/shared/primitives/keyboard-composition.ts";
import { HttpError } from "./http-error.ts";
import { gitWriteFeedback } from "./git-write-feedback.ts";
import { workspaceGitApi } from "./workspace-git-api.ts";
import { useWorkspaceGit } from "./use-workspace-git.ts";
import filesCss from "./workspace-files.module.css";
import css from "./workspace-git.module.css";
import type { PaneId } from "./ui/shared/dockkit/index.ts";
import type { GitPanelModel } from "./git-panel-model.ts";
import { GitFileReview } from "./GitFileReview.tsx";
import { WorkspaceGitDiff } from "./WorkspaceGitDiff.tsx";
import { gitAreaLabel } from "./git-labels.ts";
import { reconcileGitSelection, type GitFileSelection } from "./git-file-selection.ts";
import { GitBranchPicker } from "./GitBranchPicker.tsx";
import { WorkspaceGitHistory } from "./WorkspaceGitHistory.tsx";


function changeLabel(code: string) {
  return ({ A: t("新增", "Added"), M: t("修改", "Modified"), D: t("删除", "Deleted"), R: t("重命名", "Renamed"), C: t("复制", "Copied"), T: t("类型变化", "Type changed"), U: t("冲突", "Conflict"), "?": t("未跟踪", "Untracked") } as Record<string, string>)[code] ?? code;
}

export const WorkspaceGit = memo(function WorkspaceGit({ sessionId, visible, idle, paneId, model, onCommit }: {
  sessionId: string; visible: boolean; idle: boolean; paneId: PaneId;
  model: GitPanelModel; onCommit(hash: string, paneId: PaneId): void;
}) {
  useLocale();
  const root = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState(model.selection);
  const select = useCallback((value: GitFileSelection | null) => { model.selection = value; setSelection(value); }, [model]);
  const closePreview = useCallback(() => {
    const button = root.current?.querySelector<HTMLButtonElement>('[data-git-file][aria-pressed="true"]');
    select(null); requestAnimationFrame(() => button?.focus({ preventScroll: true }));
  }, [select]);
  const [view, setView] = useState(model.view);
  const composition = useRef<ReturnType<typeof observeComposition> | null>(null);
  useEffect(() => {
    if (!visible) return;
    const observer = observeComposition(document); composition.current = observer;
    return () => { observer.dispose(); composition.current = null; };
  }, [visible]);
  const read = useCallback((signal: AbortSignal) => workspaceGitApi.status(sessionId, signal), [sessionId]);
  const { value, loading, error } = useWorkspaceGit(read, visible && view === "changes", idle);
  const readControl = useCallback((signal: AbortSignal) => workspaceGitApi.control(sessionId, signal), [sessionId]);
  const { value: control, loading: controlLoading, error: controlError } = useWorkspaceGit(readControl, visible && view === "changes", idle);
  const [branchesOpen, setBranchesOpen] = useState(false);
  useEffect(() => { if (!visible || view !== "changes") setBranchesOpen(false); }, [visible, view]);
  const [, redraw] = useReducer(count => count + 1, 0);
  useEffect(() => { const update = () => redraw(); window.addEventListener("pi-workspace-git-changed", update); return () => window.removeEventListener("pi-workspace-git-changed", update); }, []);
  const refresh = () => window.dispatchEvent(new Event("pi-workspace-git-changed"));
  const blocked = !idle ? "agent_busy" : control?.blocked;
  const disabled = model.pending || !control?.version || controlLoading || controlError || error || !!blocked;
  const write = async (action: GitWriteAction, input: { path?: string; message?: string; branch?: string; checkout?: boolean } = {}) => {
    if (disabled || model.pending || !control) return false;
    model.pending = true; model.outcome = null; redraw();
    try {
      await workspaceGitApi.write(sessionId, { action, expected: control.version, ...input });
      model.outcome = { ok: true, reason: action };
      if (action === "commit" && model.message === input.message) model.message = "";
      if (action === "create-branch" && model.branch === input.branch) model.branch = "";
      return true;
    } catch (error) {
      model.outcome = { ok: false, reason: error instanceof HttpError ? error.reason ?? (error.status < 500 ? "git_failed" : "outcome_unknown") : "outcome_unknown" };
      return false;
    } finally {
      model.pending = false;
      window.dispatchEvent(new Event("pi-workspace-git-changed"));
    }
  };
  const repository = value?.kind === "repository" ? value : null;
  useEffect(() => {
    if (!visible || view !== "changes" || loading || error || !value) return;
    const next = reconcileGitSelection(model.selection, value.kind === "repository" ? value.entries : []);
    if (next !== model.selection) { model.selection = next; setSelection(next); }
  }, [value, loading, error, visible, view, model]);
  const groups: { title: string; area: GitDiffArea; changes: GitFileChange[]; conflict?: boolean }[] = repository ? [
    { title: t("冲突", "Conflicts"), area: "unstaged", changes: repository.entries.filter(entry => entry.conflict), conflict: true },
    { title: gitAreaLabel("staged"), area: "staged", changes: repository.entries.filter(entry => !entry.conflict && !entry.untracked && entry.index !== ".") },
    { title: gitAreaLabel("unstaged"), area: "unstaged", changes: repository.entries.filter(entry => !entry.conflict && !entry.untracked && entry.worktree !== ".") },
    { title: gitAreaLabel("untracked"), area: "untracked", changes: repository.entries.filter(entry => entry.untracked) },
  ] : [];
  const canCommit = !disabled && !repository?.scope && !!control?.staged && !!model.message.trim();
  const repoName = repository?.root.split(/[\\/]/).at(-1) ?? "";
  const info = repository ? [repository.root, repository.head, repository.upstream ?? t("未设置上游分支", "No upstream branch")].filter(Boolean).join("\n") : "";
  return <div ref={root} className={`${filesCss.body} ${css.panel}`}>
    <div className={filesCss.toolbar}>
      <div className={css.viewSwitch} role="group" aria-label={t("Git 视图", "Git view")}>{(["changes", "history"] as const).map(mode => <button type="button" key={mode} className={`${filesCss.textButton} ${css.viewButton}`} aria-pressed={view === mode} onClick={() => { model.view = mode; setView(mode); }}>{mode === "changes" ? t("改动", "Changes") : t("历史", "History")}</button>)}</div>{view === "history" && <span className={filesCss.readonly}>{t("只读", "Read only")}</span>}
      {view === "changes" && <button type="button" className={filesCss.iconButton} aria-label={t("刷新 Git 状态", "Refresh Git status")} title={t("刷新 Git 状态", "Refresh Git status")} onClick={refresh}><IconRefreshOutlineRegular /></button>}
    </div>
    {view === "history" ? <div className={filesCss.scroll}><WorkspaceGitHistory sessionId={sessionId} visible={visible} idle={idle} model={model} paneId={paneId} onCommit={onCommit} /></div> : <>
      {repository && <>
        <div className={css.repoBar}>
          <GitBranchPicker branch={repository.branch} control={control} disabled={disabled} model={model} open={branchesOpen} onOpenChange={setBranchesOpen} onDraftChange={redraw} onWrite={write} />
          <span className={css.repoName} title={info}>{repoName}</span>
          {repository.upstream && repository.ahead !== null && <span className={css.divergence} title={t("上游差异（本地记录）", "Upstream divergence (local refs)")}>↑{repository.ahead} ↓{repository.behind}</span>}
          <span className={css.count} title={t("改动文件", "Changed files")}>{repository.entries.length}{repository.truncated ? "+" : ""}</span>
        </div>
        {repository.scope && <div className={css.scope} title={repository.scope}>{t("当前目录：", "Directory: ")}{repository.scope}</div>}
      </>}
      <GitFileReview selectionKey={selection ? JSON.stringify(selection) : null} onClose={closePreview} preview={selection && repository ? <WorkspaceGitDiff key={JSON.stringify([sessionId, selection])} sessionId={sessionId} path={selection.path} area={selection.area} visible={visible && view === "changes"} idle={idle} onClose={closePreview} /> : null}>
      <div className={`${filesCss.scroll} ${css.changesScroll}`} aria-busy={loading} role="region" aria-label={t("改动文件", "Changed files")}>
        {error && <div className={filesCss.state} role="status">{t("Git 读取失败，请检查仓库或重试。", "Could not read Git. Check the repository or try again.")} <button type="button" className={filesCss.textButton} onClick={refresh}>{t("重试", "Retry")}</button></div>}
        {!value && !error && <p className={filesCss.state} role="status">{t("正在读取仓库…", "Reading repository…")}</p>}
        {value?.kind === "not-repository" && <p className={filesCss.state} role="status">{t("当前工作区不在 Git 仓库中。", "This workspace is not in a Git repository.")}</p>}
        {value?.kind === "unavailable" && <p className={filesCss.state} role="status">{t("Git 不可用，请在 Pi 所在机器安装 Git。", "Git is unavailable. Install Git on the machine running Pi.")}</p>}
        {repository && <>
          {repository.entries.length === 0 && <p className={filesCss.state} role="status">{repository.scope ? t("当前目录没有未提交改动。", "No uncommitted changes in this directory.") : t("工作区干净，没有未提交改动。", "Working tree clean. No uncommitted changes.")}</p>}
          {groups.filter(group => group.changes.length > 0).map(group => <section key={group.title} aria-label={group.title}>
            <h3 className={css.groupHeading}>{group.title}<span>{group.changes.length}</span></h3>
            <ul className={css.list}>{group.changes.map(change => {
              const code = group.conflict ? "U" : group.area === "staged" ? change.index : change.worktree;
              return <li className={css.changeRow} key={change.path}><button type="button" className={css.change} title={change.originalPath ? `${change.originalPath} → ${change.path}` : change.path} data-git-file={JSON.stringify([group.area, change.path])} aria-pressed={selection?.path === change.path && selection.area === group.area} onClick={() => select({ path: change.path, area: group.area })} aria-label={`${change.path}, ${changeLabel(code)}`}>
                <FileTypeIcon path={change.path} size={16} /><span className={css.filename}>{change.path}{change.originalPath && <small>{change.originalPath} → {change.path}</small>}</span>
                <span className={css.status} data-status={code} aria-hidden="true">{code}</span>
              </button>{!group.conflict && !change.submodule && <button type="button" className={css.fileAction} disabled={disabled} aria-label={group.area === "staged" ? t(`取消暂存 ${change.path}`, `Unstage ${change.path}`) : t(`暂存 ${change.path}`, `Stage ${change.path}`)} title={group.area === "staged" ? t("取消暂存", "Unstage") : t("暂存", "Stage")} onClick={() => { void write(group.area === "staged" ? "unstage" : "stage", { path: change.path }); }}>{group.area === "staged" ? "−" : "+"}</button>}</li>;
            })}</ul>
          </section>)}
          {repository.truncated && <p className={filesCss.state}>{t("仅显示前 1000 个改动文件，请缩小工作区范围。", "Showing the first 1000 changed files. Open a smaller workspace to see more.")}</p>}
        </>}
      </div>
      </GitFileReview>
      {repository && <div className={css.commitFooter} aria-busy={model.pending}>
        {blocked && <p className={css.hint} role="status">{gitWriteFeedback(blocked)}</p>}
        {controlError && <p className={css.hint} role="status">{t("操作状态读取失败，请刷新。", "Could not read operation state. Refresh to retry.")}</p>}
        {model.pending && !branchesOpen && <p className={css.hint} role="status">{t("正在执行 Git 操作…", "Running Git operation…")}</p>}
        {model.outcome && !branchesOpen && <div className={css.feedbackRow}><p className={css.feedback} data-error={!model.outcome.ok} role="status">{gitWriteFeedback(model.outcome.reason)}</p><button type="button" className={filesCss.iconButton} aria-label={t("关闭 Git 提示", "Dismiss Git message")} onClick={() => { model.outcome = null; redraw(); }}>×</button></div>}
        {repository.scope ? <p className={css.rootHint} title={gitWriteFeedback("root_required")}>{t("提交请打开仓库根目录", "Commit from repository root")}</p> : <form className={css.commitForm} aria-label={t("创建提交", "Create commit")} onSubmit={event => { event.preventDefault(); if (canCommit) void write("commit", { message: model.message }); }}>
          <textarea aria-label={t("提交说明", "Commit message")} rows={1} maxLength={8192} disabled={model.pending} value={model.message} placeholder={t("提交说明…", "Commit message…")} onChange={event => { model.message = event.target.value; redraw(); }} onKeyDown={event => { const composing = composition.current?.guards(event.nativeEvent) ?? event.nativeEvent.isComposing; if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !composing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
          <div className={css.actionRow}><span className={css.hint}>{control?.staged ? t(`仅暂存区 · ${control.staged} 个文件`, `Staged only · ${control.staged} files`) : t("先暂存要提交的文件", "Stage files to commit")}</span><button className={css.actionButton} type="submit" disabled={!canCommit} title={t("仅提交暂存区 · ⌘/Ctrl+Enter", "Commit staged files · ⌘/Ctrl+Enter")}>{t("提交", "Commit")}</button></div>
        </form>}
      </div>}
    </>}
  </div>;
});
