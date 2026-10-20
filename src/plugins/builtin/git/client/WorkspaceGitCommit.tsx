import { memo, useCallback, useEffect, useRef, useState } from "react";
import { FileTypeIcon } from "../../../../../web/src/ui/primitives/FileTypeIcon.tsx";
import { IconRefreshOutlineRegular } from "../../../../../web/src/ui/shared/primitives/icons/index.tsx";
import { localize as t, useLocale } from "../../../../../web/src/ui/locale/preference.ts";
import { workspaceGitApi } from "./workspace-git-api.ts";
import { useWorkspaceGit } from "./use-workspace-git.ts";
import { GitFileReview } from "./GitFileReview.tsx";
import { GitDiffView } from "./GitDiffView.tsx";
import filesCss from "../../../../../web/src/ui/workbench/WorkspacePanel.module.css";
import gitCss from "./workspace-git.module.css";
import css from "./workspace-git-history.module.css";

export const WorkspaceGitCommit = memo(function WorkspaceGitCommit({ sessionId, hash, visible, idle, onCommit }: {
  sessionId: string; hash: string; visible: boolean; idle: boolean;
  onCommit(hash: string): void;
}) {
  useLocale();
  const root = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const closePreview = () => {
    const button = root.current?.querySelector<HTMLButtonElement>('[data-git-file][aria-pressed="true"]');
    setSelected(null); requestAnimationFrame(() => button?.focus({ preventScroll: true }));
  };
  const [parentIndex, setParentIndex] = useState(0);
  const read = useCallback((signal: AbortSignal) => workspaceGitApi.commit(sessionId, hash, parentIndex, signal), [sessionId, hash, parentIndex]);
  const { value, loading, error, refresh } = useWorkspaceGit(read, visible, idle, false);
  const detail = value?.parentIndex === parentIndex ? value : null;
  useEffect(() => { if (detail && selected && !detail.files.some(file => file.path === selected)) setSelected(null); }, [detail, selected]);
  return <div className={`${filesCss.body} ${gitCss.panel}`} ref={root}>
    <div className={filesCss.toolbar}><span className={filesCss.path}>{t("提交详情", "Commit details")} · {hash.slice(0, 7)}</span><span className={filesCss.readonly}>{t("只读", "Read only")}</span>
      <button className={filesCss.iconButton} type="button" onClick={refresh} aria-label={t("刷新提交详情", "Refresh commit")}><IconRefreshOutlineRegular /></button></div>
    <GitFileReview selectionKey={selected} onClose={closePreview} preview={selected && detail ? <WorkspaceGitCommitDiff key={JSON.stringify([sessionId, hash, parentIndex, selected])} sessionId={sessionId} hash={hash} path={selected} parentIndex={parentIndex} visible={visible} idle={idle} onClose={closePreview} /> : null}>
    <div className={filesCss.scroll} aria-busy={loading}>
      {error && <p className={filesCss.state} role="status">{t("提交读取失败，可能已不可达。", "Could not read this commit. It may no longer be reachable.")} <button className={filesCss.textButton} type="button" onClick={refresh}>{t("重试", "Retry")}</button></p>}
      {!value && !error && <p className={filesCss.state} role="status">{t("正在读取提交…", "Reading commit…")}</p>}
      {value && <>
        <div className={css.detail}>
          <h2>{value.subject || t("（无提交说明）", "(No subject)")}</h2>
          <dl><dt>{t("提交", "Commit")}</dt><dd><code>{value.hash}</code></dd>
            <dt>{t("作者", "Author")}</dt><dd>{value.author} &lt;{value.email}&gt;</dd>
            <dt>{t("创作时间", "Authored")}</dt><dd><time dateTime={value.authoredAt}>{value.authoredAt}</time></dd>
            <dt>{t("提交者", "Committer")}</dt><dd>{value.committer} &lt;{value.committerEmail}&gt;</dd>
            <dt>{t("提交时间", "Committed")}</dt><dd><time dateTime={value.committedAt}>{value.committedAt}</time></dd>
            <dt>{t("父提交", "Parents")}</dt><dd className={css.parentList}>{value.parents.length ? value.parents.map((parent, index) => <button type="button" className={css.parentLink} key={parent} onClick={() => onCommit(parent)} aria-label={t(`打开父提交 ${index + 1}：${parent.slice(0, 7)}`, `Open parent ${index + 1}: ${parent.slice(0, 7)}`)}><code>{parent.slice(0, 7)}</code></button>) : t("根提交", "Root commit")}</dd></dl>
          <div className={css.message} aria-label={t("完整提交说明", "Full commit message")}>{value.message}</div>
          {value.scope && <p className={filesCss.state}>{t("文件改动仅限：", "File changes limited to: ")}{value.scope}</p>}
        </div>
        {value.parents.length > 1 ? <label className={css.parentSelect}>{t("比较基准", "Compare against")}<select aria-label={t("比较父提交", "Compare parent")} value={parentIndex} onChange={event => { setSelected(null); setParentIndex(Number(event.target.value)); }}>
          {value.parents.map((parent, index) => <option key={`${index}/${parent}`} value={index}>{t(`父提交 ${index + 1}`, `Parent ${index + 1}`)} · {parent.slice(0, 7)}</option>)}
        </select></label> : <p className={filesCss.state}>{value.parents.length ? t("与父提交比较", "Compared with parent") : t("与空目录比较", "Compared with empty tree")}</p>}
        {!detail && !error && <p className={filesCss.state} role="status">{t("正在读取文件改动…", "Reading changed files…")}</p>}
        {detail && <section aria-label={t("提交文件", "Commit files")}><h3 className={gitCss.groupHeading}>{t("改动文件", "Changed files")}<span>{detail.files.length}{detail.truncated ? "+" : ""}</span></h3>
          {detail.files.length === 0 && <p className={filesCss.state}>{t("所选比较在当前目录中没有文件改动。", "No file changes in this directory for this comparison.")}</p>}
          <ul className={gitCss.list}>{detail.files.map(file => <li key={file.path}><button className={gitCss.change} type="button" data-git-file={file.path} aria-pressed={selected === file.path} onClick={() => setSelected(file.path)} aria-label={t(`查看提交差异：${file.path}`, `View commit diff: ${file.path}`)}>
            <FileTypeIcon path={file.path} size={16} /><span className={gitCss.filename}>{file.path}</span><span className={css.fileStats}>{file.additions === null ? t("二进制", "Binary") : <><span className={gitCss.added}>+{file.additions}</span><span className={gitCss.removed}>−{file.deletions}</span></>}</span><span className={gitCss.status} data-status={file.status}>{file.status}</span>
          </button></li>)}</ul>
          {detail.truncated && <p className={filesCss.state}>{t("仅显示前 1000 个文件。", "Showing the first 1000 files.")}</p>}
        </section>}
      </>}
    </div>
    </GitFileReview>
  </div>;
});

export const WorkspaceGitCommitDiff = memo(function WorkspaceGitCommitDiff({ sessionId, hash, path, parentIndex, visible, idle, onClose }: {
  sessionId: string; hash: string; path: string; parentIndex: number; visible: boolean; idle: boolean; onClose?(): void;
}) {
  useLocale();
  const read = useCallback((signal: AbortSignal) => workspaceGitApi.commitDiff(sessionId, hash, path, parentIndex, signal), [sessionId, hash, path, parentIndex]);
  const result = useWorkspaceGit(read, visible, idle, false);
  const base = result.value ? result.value.parentHash ? `${t("父提交", "Parent")} ${result.value.parentHash.slice(0, 7)}` : t("空目录", "Empty tree") : "";
  return <GitDiffView onClose={onClose} path={path} label={`${hash.slice(0, 7)}${base ? ` · ${base}` : ""}`} {...result} />;
});
