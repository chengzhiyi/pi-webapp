import { useEffect, useMemo, useRef, useState } from "react";
import type { GitPatch } from "../../shared/workspace-git.ts";
import { IconChevronDownOutlineRegular, IconChevronUpOutlineRegular, IconRefreshOutlineRegular } from "./ui/shared/primitives/icons/index.tsx";
import { localize as t } from "./ui/locale/preference.ts";
import { previewGitPatch, type GitPatchNotice } from "./git-patch.ts";
import filesCss from "./workspace-files.module.css";
import css from "./workspace-git.module.css";

/** Shared rendering for mutable workspace diffs and immutable commit comparisons. */
export function GitDiffView({ path, label, value, loading, error, refresh, onClose }: {
  path: string; label: string; value: GitPatch | null; loading: boolean; error: boolean; refresh(): void; onClose?(): void;
}) {
  const patch = value?.kind === "text" ? value.patch : "";
  const preview = useMemo(() => previewGitPatch(patch), [patch, path]);
  const { lines, changes, notices } = preview;
  const viewport = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<{ preview: typeof preview; index: number } | null>(null);
  const active = selection?.preview === preview ? selection.index : -1;
  useEffect(() => { viewport.current?.scrollTo({ top: 0, left: 0 }); }, [preview]);
  const navigate = (index: number) => {
    if (loading || error || index < 0 || index >= changes.length) return;
    const scroller = viewport.current;
    const target = scroller?.querySelector<HTMLElement>(`[data-change="${index}"][data-change-start="true"]`);
    if (!scroller || !target) return;
    // Scroll this preview only, retaining horizontal position and keyboard focus.
    scroller.scrollTo({ top: scroller.scrollTop + target.getBoundingClientRect().top - scroller.getBoundingClientRect().top, left: scroller.scrollLeft });
    setSelection({ preview, index });
  };
  const added = lines.filter(line => line.kind === "add").length;
  const removed = lines.filter(line => line.kind === "remove").length;
  const stats = value?.kind === "text" && <span className={css.stats}><span className={css.added}>+{added}</span><span className={css.removed}>−{removed}</span></span>;
  const messages: Record<string, string> = {
    empty: t("此文件在所选范围内没有文本差异，或已不在改动列表中。", "No text differences in this scope, or this file is no longer changed."),
    binary: t("二进制文件不支持文本差异预览。", "Text diff is unavailable for binary files."),
    "too-large": t("差异过大，最多显示 512 KB / 10000 行。", "Diff exceeds the preview limit of 512 KB / 10000 lines."),
    unsupported: t("此文件类型不支持差异预览。", "Diff is unavailable for this file type."),
    conflict: t("此文件存在未解决的合并冲突，请在工作区文件或终端中检查。", "This file has unresolved merge conflicts. Inspect it in workspace files or the terminal."),
    submodule: t("子模块已发生变化，请在子模块工作区中查看具体差异。", "Submodule changed. Open its workspace to inspect the changes."),
  };
  return <div className={filesCss.body}>
    <div className={onClose ? css.inlineDiffToolbar : filesCss.toolbar}>
      {onClose ? <div className={css.diffIdentity}><span className={filesCss.path} title={path}>{path}</span><div className={css.diffDetails}><span className={css.diffArea} title={label}>{label}</span>{stats}</div></div> : <><span className={filesCss.path} title={path}>{path}</span><span className={filesCss.readonly}>{t("只读", "Read only")}</span></>}
      <div className={css.diffNavigation} role="group" aria-label={t("改动跳转", "Change navigation")}>
        <button type="button" className={filesCss.iconButton} aria-label={t("上一处改动", "Previous change")} title={t("上一处改动", "Previous change")} disabled={loading || error || active <= 0} onClick={() => navigate(active - 1)}><IconChevronUpOutlineRegular /></button>
        <span className={css.diffPosition} role="status" aria-label={t("改动位置", "Change position")} aria-live="polite" aria-atomic="true" title={t(`第 ${active + 1} / ${changes.length} 处改动`, `Change ${active + 1} of ${changes.length}`)}>{active + 1}/{changes.length}</span>
        <button type="button" className={filesCss.iconButton} aria-label={t("下一处改动", "Next change")} title={t("下一处改动", "Next change")} disabled={loading || error || active + 1 >= changes.length} onClick={() => navigate(active + 1)}><IconChevronDownOutlineRegular /></button>
      </div>
      <button type="button" className={filesCss.iconButton} aria-label={t("刷新差异", "Refresh diff")} title={t("刷新差异", "Refresh diff")} onClick={refresh}><IconRefreshOutlineRegular /></button>
      {onClose && <button type="button" className={filesCss.iconButton} aria-label={t("关闭差异预览", "Close diff preview")} title={t("关闭差异预览 · Esc", "Close diff preview · Esc")} onClick={onClose}>×</button>}
    </div>
    {!onClose && <div className={css.diffSummary}><span>{label}</span>{stats}</div>}
    {error && <div className={filesCss.state} role="status">{t("差异读取失败，请重试。", "Could not read this diff. Try again.")} <button type="button" className={filesCss.textButton} onClick={refresh}>{t("重试", "Retry")}</button></div>}
    <div className={`${filesCss.preview} ${css.diffViewport}`} aria-busy={loading}>
      {!value && !error && <p className={filesCss.state} role="status">{t("正在读取差异…", "Reading diff…")}</p>}
      {value && value.kind !== "text" && <p className={filesCss.state} role="status">{messages[value.kind]}</p>}
      {value?.kind === "text" && <div ref={viewport} className={css.diffScroll} tabIndex={0} role="region" aria-label={t("文件差异", "File diff")}>
        {notices.map((notice, index) => <p className={css.diffNotice} key={index}>{noticeText(notice)}</p>)}
        {!lines.length && !notices.length && <p className={filesCss.state}>{messages.empty}</p>}
        <pre className={css.diff}><code>{lines.map((line, index) => line.kind === "hunk" ? <span className={css.diffHunk} data-kind="hunk" key={index}><span aria-hidden="true">···</span><span>{t(`行 ${line.oldLine} / ${line.newLine}`, `Lines ${line.oldLine} / ${line.newLine}`)}{line.text && ` · ${line.text}`}</span></span> : <span className={css.diffLine} data-kind={line.kind} data-change={line.change ?? undefined} data-change-start={line.change !== null && changes[line.change] === index ? "true" : undefined} data-active={line.change !== null && active === line.change ? "true" : undefined} key={index}>
          <span className={css.lineNumber} aria-hidden="true">{line.oldLine}</span><span className={css.lineNumber} aria-hidden="true">{line.newLine}</span><span className={css.lineText}>{line.text || " "}{line.noNewline && <span className={css.noNewline} title={t("文件末尾无换行", "No newline at end of file")} aria-label={t("文件末尾无换行", "No newline at end of file")}>↵</span>}</span>
        </span>)}</code></pre>
      </div>}
    </div>
  </div>;
}

function noticeText(notice: GitPatchNotice): string {
  switch (notice.kind) {
    case "mode": return t(`文件权限：${notice.from} → ${notice.to}`, `File mode: ${notice.from} → ${notice.to}`);
    case "rename": return t(`重命名：${notice.from} → ${notice.to}`, `Renamed: ${notice.from} → ${notice.to}`);
    case "copy": return t(`复制：${notice.from} → ${notice.to}`, `Copied: ${notice.from} → ${notice.to}`);
    case "added": return t("新增空文件", "Empty file added");
    case "deleted": return t("删除空文件", "Empty file deleted");
  }
}
