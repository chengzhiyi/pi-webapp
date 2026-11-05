import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { localize as t, useLocale } from "../../../../../web/src/ui/locale/preference.ts";
import { IconAgentPresetOutlineRegular, IconChecklistOutlineRegular, IconChevronDownOutlineRegular, IconChevronRightOutlineRegular, IconRefreshOutlineRegular, IconStopFillRegular } from "../../../../../web/src/ui/shared/primitives/icons/index.tsx";
import filesCss from "../../../../../web/src/ui/workbench/WorkspacePanel.module.css";
import type { ActivityDetail, ActivityItem, ActivitySnapshot } from "../contract/activity.ts";
import { activityApi, followActivity } from "./activity-api.ts";
import css from "./workspace-activity.module.css";

const keyOf = (item: ActivityItem) => `${item.source}:${item.id}`;
const active = (item: ActivityItem) => item.status === "running" || item.status === "paused";

function duration(item: ActivityItem, now: number): string {
  if (item.startedAt === null) return "";
  const seconds = Math.max(0, Math.floor(((item.endedAt ?? now) - item.startedAt) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${seconds}s`;
}

function tokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M tokens`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k tokens`;
  return `${value} tokens`;
}

function kindLabel(item: ActivityItem): string {
  switch (item.kind) {
    case "shell": return t("命令", "Shell");
    case "workflow": return t("工作流", "Workflow");
    case "delegate": return t("委托代理", "Delegate");
    case "fusion": return "Fusion";
    case "attested": return t("认证代理", "Attested agent");
    case "managed": return t("托管任务", "Managed task");
    default: return t("子代理", "Agent");
  }
}

function ActivityKindIcon({ item }: { item: ActivityItem }) {
  if (item.kind === "shell") return <span className={css.shell}>›_</span>;
  if (item.kind === "workflow") return <IconChecklistOutlineRegular />;
  return <IconAgentPresetOutlineRegular />;
}

function ActivityOutput({ detail, error }: { detail: ActivityDetail | null; error: string }) {
  if (error) return <p className={css.detailState} role="status">{error}</p>;
  if (!detail) return <p className={css.detailState} role="status">{t("正在读取输出…", "Reading output…")}</p>;
  return <>
    {detail.outputPath && <p className={css.outputPath} title={detail.outputPath}>{detail.outputPath}</p>}
    <pre className={css.output}>{detail.text || t("暂无输出。", "No output yet.")}</pre>
    {detail.truncated && <p className={css.detailState}>{t("仅显示有界输出窗口。", "Showing a bounded output window.")}</p>}
  </>;
}

function ActivityRow({ item, now, expanded, busy, pending, detail, detailError, onToggle, onOperate }: {
  item: ActivityItem; now: number; expanded: boolean; busy: boolean; pending: boolean;
  detail: ActivityDetail | null; detailError: string;
  onToggle(item: ActivityItem): void;
  onOperate(operation: "stop" | "rerun", item: ActivityItem): void;
}) {
  const key = keyOf(item);
  const detailId = `activity-detail-${key.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  return <li className={css.item} data-status={item.status}>
    <div className={css.row}>
      <button type="button" className={css.main} disabled={!item.canOpen} aria-expanded={item.canOpen ? expanded : undefined} aria-controls={expanded ? detailId : undefined} onClick={() => onToggle(item)}>
        <span className={css.kind} aria-hidden="true"><ActivityKindIcon item={item} /></span>
        <span className={css.statusDot} data-status={item.status} role="img" aria-label={item.status} />
        <span className={css.copy}>
          <span className={css.title}>{item.title}{item.unread && <span className={css.unread} role="img" aria-label={t("未读", "Unread")} />}</span>
          <span className={css.subtitle}>{item.currentAction || item.error || item.model || kindLabel(item)}</span>
        </span>
        <span className={css.meta}><span>{duration(item, now)}</span>{item.tokens !== undefined && <span>{tokens(item.tokens)}</span>}</span>
      </button>
      <div className={css.actions}>
        {item.canRerun && <button type="button" className={filesCss.iconButton} disabled={pending} aria-label={t(`重新运行 ${item.title}`, `Rerun ${item.title}`)} title={t("重新运行", "Rerun")} onClick={() => onOperate("rerun", item)}><IconRefreshOutlineRegular /></button>}
        {item.canStop && <button type="button" className={filesCss.iconButton} disabled={pending} aria-label={t(`停止 ${item.title}`, `Stop ${item.title}`)} title={t("停止", "Stop")} onClick={() => onOperate("stop", item)}><IconStopFillRegular /></button>}
      </div>
      {busy && <span className={css.busy} role="status">{t("执行中…", "Working…")}</span>}
    </div>
    {expanded && <div className={css.detail} id={detailId}><ActivityOutput detail={detail} error={detailError} /></div>}
  </li>;
}

export function WorkspaceActivity({ sessionId, visible }: { sessionId: string; visible: boolean }) {
  useLocale();
  const [snapshot, setSnapshot] = useState<ActivitySnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState("");
  const [finishedOpen, setFinishedOpen] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<ActivityDetail | null>(null);
  const [detailError, setDetailError] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const detailGeneration = useRef(0);

  useEffect(() => {
    if (!visible) { setConnected(false); return; }
    let alive = true;
    let controller: AbortController | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const follow = async () => {
      while (alive) {
        controller = new AbortController();
        try {
          await followActivity(sessionId, controller.signal, value => {
            if (value.closed) throw new Error("Activity session was replaced");
            if (alive) { setSnapshot(value); setConnected(true); setError(""); }
          });
          if (alive) throw new Error("Activity stream closed");
        } catch (cause) {
          if (!alive || controller.signal.aborted) return;
          setConnected(false);
          setError(cause instanceof Error ? cause.message : t("活动任务连接已断开", "Activity connection closed"));
          await new Promise<void>(resolve => { retry = setTimeout(resolve, 1500); });
        }
      }
    };
    void follow();
    return () => { alive = false; controller?.abort(); if (retry) clearTimeout(retry); };
  }, [sessionId, visible]);

  const items = useMemo(() => snapshot?.items ?? [], [snapshot]);
  const running = items.filter(active);
  const finished = items.filter(item => !active(item));
  const selectedItem = items.find(item => keyOf(item) === selected && item.canOpen);

  useEffect(() => {
    if (!visible || !running.length) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [visible, running.length]);

  useEffect(() => {
    if (!selectedItem || !visible) { setDetail(null); return; }
    const generation = ++detailGeneration.current;
    const controller = new AbortController();
    let loading = false;
    const load = async () => {
      if (loading || controller.signal.aborted) return;
      loading = true;
      try {
        const value = await activityApi.detail(sessionId, selectedItem.source, selectedItem.id, controller.signal);
        if (generation === detailGeneration.current) { setDetail(value); setDetailError(""); }
      } catch (cause) {
        if (generation === detailGeneration.current && !controller.signal.aborted) setDetailError(cause instanceof Error ? cause.message : t("无法读取任务详情", "Could not read activity details"));
      } finally { loading = false; }
    };
    void load();
    const timer = active(selectedItem) ? setInterval(() => { void load(); }, 2000) : undefined;
    return () => { controller.abort(); if (timer) clearInterval(timer); };
  }, [sessionId, visible, selectedItem]);

  const refresh = useCallback(async () => {
    try { setSnapshot(await activityApi.snapshot(sessionId)); setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t("无法刷新活动任务", "Could not refresh activity")); }
  }, [sessionId]);

  const operate = async (operation: "stop" | "rerun", item: ActivityItem) => {
    const key = keyOf(item);
    if (pending || (operation === "stop" && !window.confirm(t(`停止“${item.title}”？`, `Stop “${item.title}”?`)))) return;
    setPending(key); setError("");
    try { setSnapshot(await (operation === "stop" ? activityApi.stop(sessionId, item.source, item.id) : activityApi.rerun(sessionId, item.source, item.id))); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t("任务操作失败", "Activity operation failed")); }
    finally { setPending(null); }
  };

  const renderItem = (item: ActivityItem) => <ActivityRow key={keyOf(item)} item={item} now={now} expanded={selected === keyOf(item) && !!selectedItem} busy={pending === keyOf(item)} pending={!!pending} detail={detail} detailError={detailError} onToggle={value => {
    const key = keyOf(value);
    setSelected(selected === key ? null : key); setDetail(null); setDetailError("");
  }} onOperate={(operation, value) => { void operate(operation, value); }} />;

  return <div className={`${filesCss.body} ${css.panel}`}>
    <div className={filesCss.toolbar}>
      <span className={css.connection} data-connected={connected} aria-hidden="true" />
      <span className={filesCss.path}>{running.length ? t(`${running.length} 个运行中`, `${running.length} running`) : t("后台任务", "Background tasks")}</span>
      <button type="button" className={filesCss.iconButton} aria-label={t("刷新活动任务", "Refresh activity")} title={t("刷新活动任务", "Refresh activity")} onClick={() => { void refresh(); }}><IconRefreshOutlineRegular /></button>
    </div>
    <section className={filesCss.scroll} aria-label={t("代理与后台任务", "Agents and background tasks")}>
      {error && <div className={filesCss.state} role="status">{error} <button type="button" className={filesCss.textButton} onClick={() => { void refresh(); }}>{t("重试", "Retry")}</button></div>}
      {!snapshot && !error && <p className={filesCss.state} role="status">{t("正在读取活动任务…", "Reading activity…")}</p>}
      {snapshot && <>
        {snapshot.providers.some(provider => provider.error) && <div className={css.providers}>{snapshot.providers.filter(provider => provider.error).map(provider => <p key={provider.source} title={provider.error}>{provider.source === "subagents" ? "pi-subagents" : "pi-background-tasks"}: {provider.error}</p>)}</div>}
        {!items.length && <div className={filesCss.state}>{snapshot.providers.some(provider => provider.available) ? t("当前会话没有子代理或后台任务。", "No agents or background tasks in this session.") : t("未检测到支持的活动任务包。可安装 pi-subagents 或 pi-background-tasks。", "No supported activity providers found. Install pi-subagents or pi-background-tasks to see work here.")}</div>}
        {running.length > 0 && <section aria-label={t("运行中", "Running")}><h3 className={css.groupHeading}>{t("运行中", "Running")}<span>{running.length}</span></h3><ul className={css.list}>{running.map(renderItem)}</ul></section>}
        {finished.length > 0 && <section aria-label={t("已完成", "Finished")}>
          <button type="button" className={css.finishedToggle} aria-expanded={finishedOpen} onClick={() => setFinishedOpen(value => !value)}>{finishedOpen ? <IconChevronDownOutlineRegular /> : <IconChevronRightOutlineRegular />}<span>{t("已完成", "Finished")}</span><span>{finished.length}</span></button>
          {finishedOpen && <ul className={css.list}>{finished.map(renderItem)}</ul>}
        </section>}
      </>}
    </section>
  </div>;
}
