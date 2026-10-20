import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { GitPanelModel } from "./git-panel-model.ts";
import { layoutGitGraph } from "./git-graph.ts";
import { workspaceGitApi } from "./workspace-git-api.ts";
import { useWorkspaceGit } from "./use-workspace-git.ts";
import { localize as t, useLocale } from "../../../../../web/src/ui/locale/preference.ts";
import filesCss from "../../../../../web/src/ui/workbench/WorkspacePanel.module.css";
import css from "./workspace-git-history.module.css";

export const WorkspaceGitHistory = memo(function WorkspaceGitHistory({ sessionId, visible, idle, model, onCommit }: {
  sessionId: string; visible: boolean; idle: boolean; model: GitPanelModel; onCommit(hash: string): void;
}) {
  const locale = useLocale();
  const read = useCallback((signal: AbortSignal) => workspaceGitApi.history(sessionId, undefined, signal), [sessionId]);
  const { value, loading, error, refresh } = useWorkspaceGit(read, visible, idle);
  const [history, setHistory] = useState(model.history);
  const [selected, setSelected] = useState(model.selected);
  const [more, setMore] = useState(false);
  const [pageError, setPageError] = useState(false);
  const retry = () => { setPageError(false); refresh(); };
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!value) return;
    if (model.history?.snapshot !== value.snapshot || !model.history.commits.length) {
      request.current?.abort(); setMore(false); setPageError(false);
      model.history = value; setHistory(value);
    }
  }, [value, model]);
  useEffect(() => { if (!visible) { request.current?.abort(); setMore(false); } return () => request.current?.abort(); }, [visible]);
  const loadMore = async () => {
    const current = model.history;
    if (!current?.nextCursor || more) return;
    const controller = new AbortController(); request.current = controller; setMore(true); setPageError(false);
    try {
      const page = await workspaceGitApi.history(sessionId, current.nextCursor, controller.signal);
      if (controller.signal.aborted || model.history?.snapshot !== page.snapshot || model.history.nextCursor !== current.nextCursor) return;
      const hashes = new Set(current.commits.map(commit => commit.hash));
      const combined = { ...page, commits: [...current.commits, ...page.commits.filter(commit => !hashes.has(commit.hash))] };
      model.history = combined; setHistory(combined);
    } catch { if (!controller.signal.aborted) setPageError(true); }
    finally { if (!controller.signal.aborted) setMore(false); }
  };
  const graph = useMemo(() => layoutGitGraph(history?.commits ?? []), [history?.commits]);
  const x = (lane: number) => lane * 16 + 12;
  const open = (hash: string) => { model.selected = hash; setSelected(hash); onCommit(hash); };
  const colors: CSSProperties = { "--git-graph-width": `${graph.width}px` } as CSSProperties;
  return <div className={css.history} aria-busy={loading || more}>
    <div className={css.historyToolbar}><span>{t("提交历史与分支图", "Commit history & graph")}</span><button className={filesCss.textButton} type="button" onClick={retry} aria-label={t("刷新提交历史", "Refresh history")}>{t("刷新", "Refresh")}</button></div>
    {history?.scope && <p className={filesCss.state}>{t("展示仓库提交关系；文件差异仅限当前目录：", "Repository history; file diffs are limited to: ")}{history.scope}</p>}
    {(error || pageError) && <p className={filesCss.state} role="status">{t("历史读取失败或分支已变化，请刷新历史。", "Could not read history, or refs changed. Refresh history.")} <button className={filesCss.textButton} type="button" onClick={retry}>{t("重试", "Retry")}</button></p>}
    {!history && !error && <p className={filesCss.state} role="status">{t("正在读取历史…", "Reading history…")}</p>}
    {history?.kind === "not-repository" && <p className={filesCss.state}>{t("当前工作区不在 Git 仓库中。", "This workspace is not in a Git repository.")}</p>}
    {history?.kind === "unavailable" && <p className={filesCss.state}>{t("Git 不可用。", "Git is unavailable.")}</p>}
    {history?.kind === "repository" && history.commits.length === 0 && <p className={filesCss.state} role="status">{t("仓库尚无提交。", "This repository has no commits yet.")}</p>}
    <div className={css.graphScroll}>
      <ol className={css.historyList} style={colors} aria-label={t("提交历史", "Commit history")}>
        {history?.commits.map((commit, index) => {
          const row = graph.rows[index]!;
          const refs = history.refs.filter(ref => ref.hash === commit.hash);
          const date = new Date(commit.authoredAt);
          const dateText = Number.isNaN(date.getTime()) ? commit.authoredAt : date.toLocaleDateString(locale === "zh" ? "zh-CN" : "en-US");
          return <li key={commit.hash}><button type="button" className={css.commitRow} data-commit={commit.hash} aria-current={selected === commit.hash ? "true" : undefined}
            aria-label={t(`查看提交 ${commit.hash.slice(0, 7)}：${commit.subject}`, `View commit ${commit.hash.slice(0, 7)}: ${commit.subject}`)} onClick={() => open(commit.hash)}>
            <svg width={graph.width} height={84} className={css.graph} aria-hidden="true" data-git-graph-row={commit.hash}>
              {row.rails.map((edge, index) => <path key={`r${index}`} data-color={edge.color} d={`M${x(edge.from)} 0 L${x(edge.from)} 42 C${x(edge.from)} 64 ${x(edge.to)} 64 ${x(edge.to)} 84`} />)}
              {row.incoming && <path data-color={row.color} d={`M${x(row.lane)} 0 V42`} />}
              {row.parents.map(edge => <path key={edge.hash} data-parent={edge.hash} data-color={edge.color} d={`M${x(row.lane)} 42 C${x(row.lane)} 64 ${x(edge.to)} 64 ${x(edge.to)} 84`} />)}
              <circle data-color={row.color} cx={x(row.lane)} cy={42} r={4} />
            </svg>
            <span className={css.commitCopy}>
              <span className={css.subject}>{commit.subject || t("（无提交说明）", "(No subject)")}</span>
              <span className={css.refLine} title={refs.map(ref => `${ref.kind}: ${ref.name}`).join(" · ")}>
                {history.head === commit.hash && <span className={css.ref} data-kind="head">HEAD</span>}{refs.map(ref => <span key={`${ref.kind}/${ref.name}`} className={css.ref} data-kind={ref.kind}>{ref.kind === "tag" ? `${t("标签", "tag")}: ` : ref.kind === "remote" ? `${t("远端", "remote")}: ` : ""}{ref.name}</span>)}
                {commit.parents.length > 1 && <span className={css.merge}>{t("合并", "Merge")}</span>}
              </span>
              <span className={css.commitMeta}><code>{commit.hash.slice(0, 7)}</code><span>{commit.author}</span><time dateTime={commit.authoredAt} title={commit.authoredAt}>{dateText}</time></span>
            </span>
          </button></li>;
        })}
      </ol>
    </div>
    {history?.nextCursor && <button type="button" className={css.loadMore} disabled={more || loading || history.snapshot !== value?.snapshot} onClick={() => { void loadMore(); }}>{more ? t("正在加载…", "Loading…") : t("加载更多提交", "Load more commits")}</button>}
  </div>;
});
