import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { ViewMessage, ViewUsage } from "../../pi-bridge.ts";
import { conversationTurns } from "../../conversation-turns.ts";
import { PiMarkdown } from "../../PiMarkdown.tsx";
import { IconCloseOutline16, IconDatabaseOutline16, IconSearchOutline16 } from "../primitives/icons/index.tsx";
import viewsCss from "./views.module.css";
import tableCss from "./TrajectoryTable.module.css";
import timelineCss from "./TrajectoryTimeline.module.css";
import toolbarCss from "./TrajectoryToolbar.module.css";
import css from "./PiTrajectory.module.css";
import { localize as t, useLocale } from "../locale/preference.ts";

type RecordKind = "user" | "message" | "tool";
interface TrajectoryRecord {
  id: string;
  callId?: string;
  kind: RecordKind;
  label: string;
  toolName?: string;
  text: string;
  preview: string;
  result?: string;
  timestamp: string;
  usage?: ViewUsage;
  error?: boolean;
  turn: number;
  index: number;
}
type DisplayRow = { type: "record"; record: TrajectoryRecord; firstInTurn: boolean } | { type: "collapsed"; turn: number; count: number };

function compact(text: string): string { return text.replace(/\s+/g, " ").trim(); }
function toolPreview(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text));
  } catch { return compact(text); }
}

function makeRecords(messages: ViewMessage[]): TrajectoryRecord[] {
  const results = new Map(messages.filter((message) => message.role === "tool" && message.toolCallId)
    .map((message) => [message.toolCallId!, message]));
  let index = 0;
  return conversationTurns(messages).flatMap((turn) => {
    const records: TrajectoryRecord[] = [];
    const called = new Set(turn.messages.flatMap((message) => message.blocks.filter((block) => block.kind === "toolCall" && block.toolCallId).map((block) => block.toolCallId!)));
    for (const message of turn.messages) {
      if (message.role === "tool" && message.toolCallId && called.has(message.toolCallId)) continue;
      for (const [blockIndex, block] of message.blocks.entries()) {
        const kind: RecordKind = message.role === "user" ? "user" : message.role === "tool" || block.kind === "toolCall" ? "tool" : "message";
        const result = block.kind === "toolCall" && block.toolCallId ? results.get(block.toolCallId) : undefined;
        records.push({
          id: `${message.id}-${blockIndex}`,
          ...(block.toolCallId || message.toolCallId ? { callId: block.toolCallId ?? message.toolCallId } : {}),
          kind,
          label: kind === "tool" ? t("工具", "Tool") : message.role === "user" ? t("用户", "User") : t("助手", "Assistant"),
          ...(kind === "tool" ? { toolName: block.kind === "toolCall" ? block.toolName || t("工具", "Tool") : message.toolName || t("工具", "Tool") } : {}),
          text: block.text,
          preview: block.kind === "toolCall" ? toolPreview(block.text) : compact(block.text),
          ...(result ? { result: compact(result.blocks.map((part) => part.text).join(" ")) } : {}),
          timestamp: message.timestamp,
          ...(message.usage && blockIndex === message.blocks.length - 1 ? { usage: message.usage } : {}),
          ...(message.isError || result?.isError ? { error: true } : {}),
          turn: turn.index,
          index: ++index,
        });
      }
    }
    return records;
  });
}
function metric(value: number | undefined): string { return value === undefined ? "" : value.toLocaleString(); }

/** Pi events displayed in the trajectory table, toolbar and timeline. */
export function PiTrajectory({ messages, inspectCallId }: { messages: ViewMessage[]; inspectCallId: string | null }) {
  const locale = useLocale();
  const records = useMemo(() => makeRecords(messages), [messages, locale]);
  const turnCount = records.at(-1)?.turn ?? 0;
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [collapsedTurns, setCollapsedTurns] = useState<Set<number>>(new Set());
  const [collapseCalls, setCollapseCalls] = useState(false);
  const [actualDuration, setActualDuration] = useState(false);
  const tablePane = useRef<HTMLDivElement>(null);
  useEffect(() => { if (inspectCallId) setSelectedId(records.find((record) => record.callId === inspectCallId)?.id ?? null); }, [inspectCallId, records]);
  const selected = records.find((record) => record.id === selectedId) ?? null;
  const needle = query.trim().toLocaleLowerCase();
  const visible = records.filter((record) => !collapsedTurns.has(record.turn) && (!collapseCalls || record.kind !== "tool")
    && (!needle || `${record.label} ${record.toolName ?? ""} ${record.preview} ${record.result ?? ""}`.toLocaleLowerCase().includes(needle)));
  const byTurn = new Map<number, TrajectoryRecord[]>();
  for (const record of visible) {
    const group = byTurn.get(record.turn) ?? [];
    group.push(record);
    byTurn.set(record.turn, group);
  }
  const countByTurn = new Map<number, number>();
  for (const record of records) countByTurn.set(record.turn, (countByTurn.get(record.turn) ?? 0) + 1);
  const displayRows = Array.from({ length: turnCount }, (_, index) => index + 1).flatMap((turn): DisplayRow[] => {
    if (collapsedTurns.has(turn)) return [{ type: "collapsed" as const, turn, count: countByTurn.get(turn) ?? 0 }];
    const matching = byTurn.get(turn) ?? [];
    return matching.map((record, index) => ({ type: "record" as const, record, firstInTurn: index === 0 }));
  });
  const firstTime = records.length ? Date.parse(records[0]!.timestamp) : 0;
  const lastTime = records.length ? Date.parse(records[records.length - 1]!.timestamp) : firstTime;
  const span = Math.max(1, lastTime - firstTime);
  const select = (record: TrajectoryRecord) => {
    setSelectedId(record.id);
    tablePane.current?.querySelector<HTMLElement>(`[data-record-index="${record.index}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  };
  return <div className={viewsCss.root} data-conversation-composer-overlay aria-label={t("会话轨迹", "Session trajectory")}>
    <div className={toolbarCss.root} role="toolbar" aria-label={t("轨迹工具栏", "Trajectory toolbar")}><div className={toolbarCss.inner}>
      <div className={toolbarCss.actions}>
        <button type="button" className={toolbarCss.toggle} aria-pressed={actualDuration} title={actualDuration ? t("均匀排列事件", "Space events evenly") : t("按实际时长排列事件", "Space events by actual duration")} onClick={() => setActualDuration((value) => !value)}>
          <svg className={toolbarCss.toggleIcon} viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="5.25" /><path d="M8 4.75V8l2.25 1.5" /></svg>{t("时长", "Duration")}
        </button>
        <button type="button" className={toolbarCss.action} aria-pressed={turnCount > 0 && collapsedTurns.size === turnCount} aria-label={turnCount > 0 && collapsedTurns.size === turnCount ? t("展开轮次", "Expand turns") : t("折叠轮次", "Collapse turns")} onClick={() => setCollapsedTurns((current) => current.size === turnCount ? new Set() : new Set(Array.from({ length: turnCount }, (_, index) => index + 1)))}><span className={toolbarCss.actionIcon} aria-hidden="true">{collapsedTurns.size === turnCount ? "⊞" : "⊟"}</span>{t("轮次", "Turns")}</button>
        <button type="button" className={toolbarCss.action} aria-pressed={collapseCalls} aria-label={collapseCalls ? t("展开调用", "Expand calls") : t("折叠调用", "Collapse calls")} onClick={() => setCollapseCalls((value) => !value)}><span className={toolbarCss.actionIcon} aria-hidden="true">{collapseCalls ? "⊞" : "⊟"}</span>{t("调用", "Calls")}</button>
      </div>
      <label className={toolbarCss.search}><IconSearchOutline16 size={11} className={toolbarCss.searchIcon} /><input type="search" className={toolbarCss.searchInput} aria-label={t("搜索轨迹", "Search trajectory")} placeholder={t("搜索", "Search")} value={query} onChange={(event) => setQuery(event.target.value)} /></label>
    </div></div>
    <section className={timelineCss.root} aria-label={t("会话时间线", "Session timeline")}><div className={timelineCss.plot}>
      <div className={timelineCss.labels} aria-hidden="true"><span>{t("输入", "Input")}</span><span>{t("模型", "Model")}</span><span>{t("工具", "Tool")}</span></div>
      <div className={timelineCss.track}><div className={timelineCss.lanes} style={{ "--trajectory-domain-left": "0%", "--trajectory-domain-width": "100%" } as CSSProperties}>
        {records.map((record) => {
          const position = actualDuration ? (Date.parse(record.timestamp) - firstTime) / span : (record.index - 1) / Math.max(1, records.length);
          return <button key={record.id} type="button" title={`${record.toolName ?? record.label} · ${record.preview.slice(0, 80)}`} aria-label={t(`第 ${record.index} 条：${record.toolName ?? record.label}`, `Record ${record.index}: ${record.toolName ?? record.label}`)} className={`${timelineCss.span} ${css.timelineButton}`} data-timeline-span={record.kind === "tool" ? "tool" : record.kind === "user" ? "user" : "message"} data-equal-duration="true" data-current={selectedId === record.id || undefined} data-error={record.error || undefined} style={{ "--trajectory-span-left": `${Math.min(99, Math.max(0, position * 100))}%`, "--trajectory-span-width": "0%", "--trajectory-span-gap": "0px", "--trajectory-span-lane": record.kind === "user" ? 0 : record.kind === "tool" ? 2 : 1 } as CSSProperties} onClick={() => select(record)} />;
        })}
      </div></div>
    </div></section>
    <div className={viewsCss.ledger}>
      <div ref={tablePane} className={tableCss.tablePane}>
        <table className={tableCss.table} data-scroll-ready="true" aria-label={t("轨迹记录", "Trajectory records")}><colgroup><col className={tableCss.eventColumn} /><col className={tableCss.contentColumn} /></colgroup><tbody>
          {displayRows.map((row) => row.type === "collapsed"
            ? <tr key={`collapsed-${row.turn}`} tabIndex={0} data-collapsed-summary="turn" data-turn-start="true" aria-label={t(`展开第 ${row.turn} 轮`, `Expand turn ${row.turn}`)} onClick={() => setCollapsedTurns((current) => { const next = new Set(current); next.delete(row.turn); return next; })} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setCollapsedTurns((current) => { const next = new Set(current); next.delete(row.turn); return next; }); } }}><td className={tableCss.event}><span className={tableCss.turnLabel}>{t(`第 ${row.turn} 轮`, `Turn ${row.turn}`)}</span></td><td className={tableCss.content}><span className={tableCss.collapsedTurnContent}><span className={tableCss.collapsedTurnEllipsis}>…</span><span className={tableCss.collapsedTurnText}>{t(`${row.count} 条记录，点击展开`, `${row.count} records, click to expand`)}</span></span></td></tr>
            : <tr key={row.record.id} tabIndex={0} data-record-index={row.record.index} data-kind={row.record.kind} data-turn-start={row.firstInTurn || undefined} data-error={row.record.error || undefined} data-selected={selectedId === row.record.id || undefined} aria-selected={selectedId === row.record.id} aria-label={t(`第 ${row.record.turn} 轮，${row.record.label}，${row.record.preview}`, `Turn ${row.record.turn}, ${row.record.label}, ${row.record.preview}`)} onClick={() => select(row.record)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(row.record); } }}>
            <td className={tableCss.event}>
              {row.firstInTurn && <button type="button" className={css.turnLabelButton} aria-label={t(`折叠第 ${row.record.turn} 轮`, `Collapse turn ${row.record.turn}`)} onClick={(event) => { event.stopPropagation(); setCollapsedTurns((current) => new Set([...current, row.record.turn])); }}><span className={tableCss.turnLabel}>{t(`第 ${row.record.turn} 轮`, `Turn ${row.record.turn}`)}</span></button>}
              <div className={tableCss.eventInner}><span className={tableCss.kindSlot}><span className={`${tableCss.kindTag} ${row.record.kind === "user" ? tableCss.user : row.record.kind === "tool" ? tableCss.toolAmber : tableCss.assistantVioletBright}`}><span className={tableCss.kindTagLabel}>{row.record.label}</span></span></span></div>
              {selectedId === row.record.id && <span className={tableCss.selectionRail} aria-hidden="true" />}
            </td>
            <td className={tableCss.content}><span className={row.record.result === undefined ? tableCss.contentText : tableCss.resultPreview} title={row.record.result === undefined ? row.record.preview : `${row.record.label} ${row.record.preview} → ${row.record.result}`}>
              <span className={row.record.result === undefined ? undefined : tableCss.resultRequest}>{row.record.kind === "tool" && <span className={tableCss.toolCallNameTypeface}>{row.record.toolName}</span>}<span className={row.record.kind === "tool" ? tableCss.toolCallPayload : undefined}>{row.record.preview}</span></span>
              {row.record.result !== undefined && <span className={`${tableCss.inlineResult} ${row.record.error ? tableCss.error : ""}`}><span className={tableCss.arrow}>→</span><span className={tableCss.inlineResultText}>{row.record.result}</span></span>}
            </span></td>
          </tr>)}
          {displayRows.length === 0 && <tr><td colSpan={2} className={css.empty}>{records.length === 0 ? t("暂无轨迹", "No trajectory yet") : t("没有匹配的记录", "No matching records")}</td></tr>}
        </tbody></table>
      </div>
      {selected && <aside className={tableCss.details} aria-label={t("轨迹详情", "Trajectory details")}>
        <div className={tableCss.detailsHeader}><span className={tableCss.detailsTitle}>{selected.kind === "tool" ? <span className={tableCss.requestDetailsDot} /> : <IconDatabaseOutline16 size={14} />}<span className={tableCss.requestDetailsName}>{selected.toolName ?? selected.label}</span><span className={tableCss.detailsLocation}>{t(`第 ${selected.turn} 轮`, `Turn ${selected.turn}`)} · #{selected.index}</span></span><button type="button" className={tableCss.close} aria-label={t("关闭详情", "Close details")} onClick={() => setSelectedId(null)}><IconCloseOutline16 /></button></div>
        <div className={tableCss.detailBody}>
          <dl className={tableCss.overview}><div><dt>{t("时间", "Time")}</dt><dd>{new Date(selected.timestamp).toLocaleString(t("zh-CN", "en-US"))}</dd></div>{selected.callId && <div><dt>{t("调用 ID", "Call ID")}</dt><dd>{selected.callId}</dd></div>}{selected.usage && <><div><dt>{t("输入", "Input")}</dt><dd>{metric(selected.usage.input)}</dd></div><div><dt>{t("缓存读取", "Cache read")}</dt><dd>{metric(selected.usage.cacheRead)}</dd></div><div><dt>{t("缓存写入", "Cache write")}</dt><dd>{metric(selected.usage.cacheWrite)}</dd></div><div><dt>{t("输出", "Output")}</dt><dd>{metric(selected.usage.output)}</dd></div></>}</dl>
          <div className={tableCss.overviewHeading}>{t("内容", "Content")}</div>{selected.kind === "tool" ? <pre className={tableCss.payload}>{selected.text}</pre> : <div className={tableCss.markdownPayload}><PiMarkdown text={selected.text} /></div>}
          {selected.result !== undefined && <><div className={tableCss.overviewHeading}>{t("结果", "Result")}</div><pre className={tableCss.payload}>{selected.result}</pre></>}
        </div>
      </aside>}
    </div>
  </div>;
}
