import { useEffect, useRef, useState } from "react";
import type { GitControlState } from "../contract/workspace-git.ts";
import type { GitPanelModel } from "./git-panel-model.ts";
import { gitWriteFeedback } from "./git-write-feedback.ts";
import { localize as t } from "../../../../../web/src/ui/locale/preference.ts";
import { MenuSurface } from "../../../../../web/src/ui/shared/primitives/MenuSurface.tsx";
import { useModalLayer } from "../../../../../web/src/ui/shared/primitives/useModalLayer.ts";
import { IconBranchOutlineRegular, IconChevronDownOutlineRegular, IconPlusOutlineRegular } from "../../../../../web/src/ui/shared/primitives/icons/index.tsx";
import filesCss from "../../../../../web/src/ui/workbench/WorkspacePanel.module.css";
import css from "./workspace-git.module.css";

type BranchAction = "create-branch" | "switch-branch";
export function GitBranchPicker({ branch, control, disabled, model, open, onOpenChange, onDraftChange, onWrite }: {
  branch: string | null; control: GitControlState | null; disabled: boolean; model: GitPanelModel; open: boolean;
  onOpenChange(open: boolean): void; onDraftChange(): void;
  onWrite(action: BranchAction, input: { branch: string; checkout?: boolean }): Promise<boolean>;
}) {
  const anchor = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [creating, setCreating] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [query, setQuery] = useState("");
  useModalLayer(dialog, open, () => onOpenChange(false));
  useEffect(() => {
    if (!open) { setCreating(false); setQuery(""); setAttempted(false); return; }
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !anchor.current?.contains(event.target)) onOpenChange(false); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open, onOpenChange]);
  useEffect(() => { if (creating) input.current?.focus(); }, [creating]);
  const switchBlocked = control?.scope ? "root_required" : control?.dirty ? "dirty_worktree" : null;
  const branches = control?.branches.filter(item => item.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())) ?? [];
  const run = async (action: BranchAction, input: { branch: string; checkout?: boolean }) => {
    setAttempted(true);
    if (await onWrite(action, input)) onOpenChange(false);
  };
  return <div ref={anchor} className={css.branchPicker}>
    <button type="button" className={css.branchTrigger} disabled={!control} aria-label={t("管理分支", "Manage branches")} aria-haspopup="dialog" aria-expanded={open} title={branch ?? t("分离 HEAD", "Detached HEAD")} onClick={() => onOpenChange(!open)}>
      <IconBranchOutlineRegular /><span>{branch ?? t("分离 HEAD", "Detached HEAD")}</span><IconChevronDownOutlineRegular />
    </button>
    {open && <MenuSurface ref={dialog} className={css.branchPopover} compact role="dialog" aria-modal="true" aria-label={t("管理分支", "Manage branches")}>
      <div className={css.pickerHeader}>
        <span>{creating ? t("新建分支", "New branch") : t("本地分支", "Local branches")}</span>
        <button type="button" className={filesCss.iconButton} aria-label={t("关闭分支面板", "Close branches")} onClick={() => onOpenChange(false)}>×</button>
      </div>
      {creating ? <form className={css.form} aria-label={t("创建分支", "Create branch")} onSubmit={event => { event.preventDefault(); if (!disabled && model.branch.trim() && control?.head && !(model.checkout && switchBlocked)) void run("create-branch", { branch: model.branch, checkout: model.checkout }); }}>
        <label className={css.field}>{t("分支名称", "Branch name")}<input ref={input} aria-label={t("新分支名称", "New branch name")} maxLength={256} value={model.branch} disabled={model.pending} placeholder="feature/name" onChange={event => { model.branch = event.target.value; onDraftChange(); }} /></label>
        <label className={css.checkbox}><input type="checkbox" checked={model.checkout} disabled={model.pending} onChange={event => { model.checkout = event.target.checked; onDraftChange(); }} />{t("创建后切换", "Switch after creating")}</label>
        {model.checkout && switchBlocked && <p className={css.hint}>{gitWriteFeedback(switchBlocked)}</p>}
        <div className={css.actionRow}><button type="button" className={filesCss.textButton} onClick={() => setCreating(false)}>{t("返回", "Back")}</button><button className={css.actionButton} type="submit" disabled={disabled || !model.branch.trim() || !control?.head || (model.checkout && !!switchBlocked)}>{t("创建分支", "Create branch")}</button></div>
      </form> : <>
        <input className={css.branchSearch} type="search" data-modal-autofocus aria-label={t("搜索分支", "Search branches")} value={query} placeholder={t("搜索分支…", "Search branches…")} onChange={event => setQuery(event.target.value)} />
        <div className={css.branchList} role="group" aria-label={t("本地分支", "Local branches")}>
          {branches.map(item => <button type="button" className={css.branchOption} key={item.name} title={item.name} disabled={disabled || !!switchBlocked || item.current || item.occupied || !control?.head} aria-label={t(`切换到分支：${item.name}`, `Switch to branch: ${item.name}`)} onClick={() => { void run("switch-branch", { branch: item.name }); }}>
            <IconBranchOutlineRegular /><span>{item.name}</span>{(item.current || item.occupied) && <small>{item.current ? t("当前", "Current") : t("其他工作树", "Other worktree")}</small>}
          </button>)}
          {branches.length === 0 && <p className={css.hint}>{t("没有匹配的分支。", "No matching branches.")}</p>}
        </div>
        {switchBlocked && <p className={css.hint}>{gitWriteFeedback(switchBlocked)}</p>}
        <button type="button" className={css.newBranch} disabled={model.pending || !control?.head} aria-label={t("新建分支", "New branch")} onClick={() => setCreating(true)}><IconPlusOutlineRegular />{t("新建分支…", "New branch…")}</button>
      </>}
      {!control?.head && <p className={css.hint}>{gitWriteFeedback("no_commits")}</p>}
      {model.pending && <p className={css.hint} role="status">{t("正在执行…", "Running…")}</p>}
      {control?.blocked && <p className={css.hint}>{gitWriteFeedback(control.blocked)}</p>}
      {attempted && model.outcome && !model.outcome.ok && <p className={css.feedback} data-error="true" role="status">{gitWriteFeedback(model.outcome.reason)}</p>}
    </MenuSurface>}
  </div>;
}
