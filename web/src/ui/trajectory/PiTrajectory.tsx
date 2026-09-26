import { useEffect, useMemo, useRef, useState } from "react";
import type { ViewMessage, ViewUsage } from "../../pi-bridge.ts";
import { conversationTurns } from "../../conversation-turns.ts";
import { PiMarkdown } from "../../PiMarkdown.tsx";
import { IconCloseOutline16, IconDatabaseOutline16, IconSearchOutline16 } from "../primitives/icons/index.tsx";
import viewsCss from "./views.module.css";
import tableCss from "./TrajectoryTable.module.css";
import { PiTimeline } from "./PiTimeline.tsx";
import { timelineFocusIndexes, trajectoryTimeline } from "./timeline-model.ts";
import toolbarCss from "./TrajectoryToolbar.module.css";
import css from "./PiTrajectory.module.css";

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
  endTimestamp?: string;
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
          label: kind === "tool" ? "工具" : message.role === "user" ? "用户" : "助手",
          ...(kind === "tool" ? { toolName: block.kind === "toolCall" ? block.toolName || "工具" : message.toolName || "工具" } : {}),
          text: block.text,
          preview: block.kind === "toolCall" ? toolPreview(block.text) : compact(block.text),
          ...(result ? { result: compact(result.blocks.map((part) => part.text).join(" ")) } : {}),
          timestamp: message.timestamp,
          ...(result ? { endTimestamp: result.timestamp } : {}),
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
function clampDetailsWidth(width: number, splitWidth: number): number {
  return Math.round(Math.min(Math.max(width, 320), Math.max(320, Math.min(720, splitWidth - 280))));
}

/** Pi events displayed in the trajectory table, toolbar and timeline. */
export function PiTrajectory({ messages, inspectCallId }: { messages: ViewMessage[]; inspectCallId: string | null }) {
  const records = useMemo(() => makeRecords(messages), [messages]);
  const turnCount = records.at(-1)?.turn ?? 0;
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [collapsedTurns, setCollapsedTurns] = useState<Set<number>>(new Set());
  const [collapseCalls, setCollapseCalls] = useState(false);
  const [actualDuration, setActualDuration] = useState(false);
  const [timelineRange, setTimelineRange] = useState<{ start: number; end: number } | null>(null);
  const [detailsWidth, setDetailsWidth] = useState<number | null>(null);
  const detailsResizeDrag = useRef<{ pointerId: number; startX: number; startWidth: number; splitWidth: number } | null>(null);
  const tablePane = useRef<HTMLDivElement>(null);
  useEffect(() => { if (inspectCallId) setSelectedId(records.find((record) => record.callId === inspectCallId)?.id ?? null); }, [inspectCallId, records]);
  const selected = records.find((record) => record.id === selectedId) ?? null;
  const needle = query.trim().toLocaleLowerCase();
  const timeline = useMemo(() => trajectoryTimeline(records, actualDuration), [records, actualDuration]);
  const focusedIndexes = timeline && timelineRange ? timelineFocusIndexes(timeline, timelineRange.start, timelineRange.end) : null;
  const matchingIndexes = needle ? new Set(records.filter((record) => `${record.label} ${record.toolName ?? ""} ${record.preview} ${record.result ?? ""}`.toLocaleLowerCase().includes(needle)).map((record) => record.index)) : null;
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
  const select = (record: TrajectoryRecord) => {
    setSelectedId(record.id);
    tablePane.current?.querySelector<HTMLElement>(`[data-record-index="${record.index}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  };
  return <div className={viewsCss.root} data-conversation-composer-overlay aria-label="会话轨迹">
    <div className={toolbarCss.root} role="toolbar" aria-label="轨迹工具栏"><div className={toolbarCss.inner}>
      <div className={toolbarCss.actions}>
        <button type="button" className={toolbarCss.toggle} aria-pressed={actualDuration} title={actualDuration ? "按事件顺序排列" : "按记录时间排列"} onClick={() => setActualDuration((value) => !value)}>
          <svg className={toolbarCss.toggleIcon} viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="5.25" /><path d="M8 4.75V8l2.25 1.5" /></svg>时长
        </button>
        <button type="button" className={toolbarCss.action} aria-pressed={turnCount > 0 && collapsedTurns.size === turnCount} aria-label={turnCount > 0 && collapsedTurns.size === turnCount ? "展开轮次" : "折叠轮次"} onClick={() => setCollapsedTurns((current) => current.size === turnCount ? new Set() : new Set(Array.from({ length: turnCount }, (_, index) => index + 1)))}><span className={toolbarCss.actionIcon} aria-hidden="true">{collapsedTurns.size === turnCount ? "⊞" : "⊟"}</span>轮次</button>
        <button type="button" className={toolbarCss.action} aria-pressed={collapseCalls} aria-label={collapseCalls ? "展开调用" : "折叠调用"} onClick={() => setCollapseCalls((value) => !value)}><span className={toolbarCss.actionIcon} aria-hidden="true">{collapseCalls ? "⊞" : "⊟"}</span>调用</button>
      </div>
      <label className={toolbarCss.search}><IconSearchOutline16 size={11} className={toolbarCss.searchIcon} /><input type="search" className={toolbarCss.searchInput} aria-label="搜索轨迹" placeholder="搜索" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
    </div></div>
    <PiTimeline t={(zh) => zh} model={timeline} actualTime={actualDuration} selectedIndex={selected?.index ?? null} matchingIndexes={matchingIndexes} range={timelineRange} onRangeChange={setTimelineRange} onSelect={(index) => { const record = records.find((item) => item.index === index); if (record) select(record); }} />
    <div className={viewsCss.ledger}>
      <div ref={tablePane} className={tableCss.tablePane}>
        <table className={tableCss.table} data-scroll-ready="true" aria-label="轨迹记录"><colgroup><col className={tableCss.eventColumn} /><col className={tableCss.contentColumn} /></colgroup><tbody>
          {displayRows.map((row) => row.type === "collapsed"
            ? <tr key={`collapsed-${row.turn}`} tabIndex={0} data-collapsed-summary="turn" data-turn-start="true" aria-label={`展开第 ${row.turn} 轮`} onClick={() => setCollapsedTurns((current) => { const next = new Set(current); next.delete(row.turn); return next; })} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setCollapsedTurns((current) => { const next = new Set(current); next.delete(row.turn); return next; }); } }}><td className={tableCss.event}><span className={tableCss.turnLabel}>第 {row.turn} 轮</span></td><td className={tableCss.content}><span className={tableCss.collapsedTurnContent}><span className={tableCss.collapsedTurnEllipsis}>…</span><span className={tableCss.collapsedTurnText}>{row.count} 条记录，点击展开</span></span></td></tr>
            : <tr key={row.record.id} tabIndex={0} data-record-index={row.record.index} data-kind={row.record.kind} data-turn-start={row.firstInTurn || undefined} data-error={row.record.error || undefined} data-selected={selectedId === row.record.id || undefined} data-timeline-focus={focusedIndexes ? focusedIndexes.has(row.record.index) ? "inside" : "outside" : undefined} aria-selected={selectedId === row.record.id} aria-label={`第 ${row.record.turn} 轮，${row.record.label}，${row.record.preview}`} onClick={() => select(row.record)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(row.record); } }}>
            <td className={tableCss.event}>
              {row.firstInTurn && <button type="button" className={css.turnLabelButton} aria-label={`折叠第 ${row.record.turn} 轮`} onClick={(event) => { event.stopPropagation(); setCollapsedTurns((current) => new Set([...current, row.record.turn])); }}><span className={tableCss.turnLabel}>第 {row.record.turn} 轮</span></button>}
              <div className={tableCss.eventInner}><span className={tableCss.kindSlot}><span className={`${tableCss.kindTag} ${row.record.kind === "user" ? tableCss.user : row.record.kind === "tool" ? tableCss.toolAmber : tableCss.assistantVioletBright}`}><span className={tableCss.kindTagLabel}>{row.record.label}</span></span></span></div>
              {selectedId === row.record.id && <span className={tableCss.selectionRail} aria-hidden="true" />}
            </td>
            <td className={tableCss.content}><span className={row.record.result === undefined ? tableCss.contentText : tableCss.resultPreview} title={row.record.result === undefined ? row.record.preview : `${row.record.label} ${row.record.preview} → ${row.record.result}`}>
              <span className={row.record.result === undefined ? undefined : tableCss.resultRequest}>{row.record.kind === "tool" && <span className={tableCss.toolCallNameTypeface}>{row.record.toolName}</span>}<span className={row.record.kind === "tool" ? tableCss.toolCallPayload : undefined}>{row.record.preview}</span></span>
              {row.record.result !== undefined && <span className={`${tableCss.inlineResult} ${row.record.error ? tableCss.error : ""}`}><span className={tableCss.arrow}>→</span><span className={tableCss.inlineResultText}>{row.record.result}</span></span>}
            </span></td>
          </tr>)}
          {displayRows.length === 0 && <tr><td colSpan={2} className={css.empty}>{records.length === 0 ? "暂无轨迹" : "没有匹配的记录"}</td></tr>}
        </tbody></table>
      </div>
      {selected && <aside id="trajectory-detail-panel" className={tableCss.details} aria-label="轨迹详情" style={detailsWidth === null ? undefined : { width: detailsWidth }}>
        <div className={tableCss.detailsResizeHandle} role="separator" aria-label={"调整轨迹详情宽度"} aria-controls="trajectory-detail-panel" aria-orientation="vertical" tabIndex={0} title={"拖动调整详情宽度，双击恢复"} onDoubleClick={() => setDetailsWidth(null)}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            const details = event.currentTarget.parentElement;
            const splitWidth = details?.parentElement?.getBoundingClientRect().width;
            if (!details || !splitWidth) return;
            detailsResizeDrag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: details.getBoundingClientRect().width, splitWidth };
            event.currentTarget.setPointerCapture(event.pointerId);
            event.preventDefault();
          }}
          onPointerMove={(event) => {
            const drag = detailsResizeDrag.current;
            if (!drag || drag.pointerId !== event.pointerId) return;
            setDetailsWidth(clampDetailsWidth(drag.startWidth + drag.startX - event.clientX, drag.splitWidth));
          }}
          onPointerUp={(event) => {
            if (detailsResizeDrag.current?.pointerId !== event.pointerId) return;
            detailsResizeDrag.current = null;
            event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={() => { detailsResizeDrag.current = null; }}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            const details = event.currentTarget.parentElement;
            const splitWidth = details?.parentElement?.getBoundingClientRect().width;
            if (!details || !splitWidth) return;
            setDetailsWidth(clampDetailsWidth(details.getBoundingClientRect().width + (event.key === "ArrowLeft" ? 16 : -16), splitWidth));
            event.preventDefault();
          }} />
                <div className={tableCss.detailsHeader}><span className={tableCss.detailsTitle}>{selected.kind === "tool" ? <span className={tableCss.requestDetailsDot} /> : <IconDatabaseOutline16 size={14} />}<span className={tableCss.requestDetailsName}>{selected.toolName ?? selected.label}</span><span className={tableCss.detailsLocation}>第 {selected.turn} 轮 · #{selected.index}</span></span><button type="button" className={tableCss.close} aria-label="关闭详情" onClick={() => setSelectedId(null)}><IconCloseOutline16 /></button></div>
        <div className={tableCss.detailBody}>
          <dl className={tableCss.overview}><div><dt>时间</dt><dd>{new Date(selected.timestamp).toLocaleString("zh-CN")}</dd></div>{selected.callId && <div><dt>调用 ID</dt><dd>{selected.callId}</dd></div>}{selected.usage && <><div><dt>输入</dt><dd>{metric(selected.usage.input)}</dd></div><div><dt>缓存读取</dt><dd>{metric(selected.usage.cacheRead)}</dd></div><div><dt>缓存写入</dt><dd>{metric(selected.usage.cacheWrite)}</dd></div><div><dt>输出</dt><dd>{metric(selected.usage.output)}</dd></div></>}</dl>
          <div className={tableCss.overviewHeading}>内容</div>{selected.kind === "tool" ? <pre className={tableCss.payload}>{selected.text}</pre> : <div className={tableCss.markdownPayload}><PiMarkdown text={selected.text} /></div>}
          {selected.result !== undefined && <><div className={tableCss.overviewHeading}>结果</div><pre className={tableCss.payload}>{selected.result}</pre></>}
        </div>
      </aside>}
    </div>
  </div>;
}
