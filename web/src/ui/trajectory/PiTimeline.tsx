import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import type { TimelineModel } from "./timeline-model.ts";
import timelineCss from "./TrajectoryTimeline.module.css";
import css from "./PiTrajectory.module.css";

type Range = { start: number; end: number };

function clamp(value: number, min: number, max: number) { return Math.min(max, Math.max(min, value)); }

/** DSH's overview gestures adapted to Pi's event timestamps. */
export function PiTimeline({ t, model, actualTime, selectedIndex, matchingIndexes, range, onRangeChange, onSelect }: {
  t: (zh: string, en: string) => string;
  model: TimelineModel | null;
  actualTime: boolean;
  selectedIndex: number | null;
  matchingIndexes: ReadonlySet<number> | null;
  range: Range | null;
  onRangeChange: (range: Range | null) => void;
  onSelect: (index: number) => void;
}) {
  const root = useRef<HTMLElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; clientX: number; time: number; index: number | null; pan: boolean; viewportStart: number } | null>(null);
  const [draft, setDraft] = useState<Range | null>(null);
  const [viewport, setViewport] = useState<Range | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [panning, setPanning] = useState(false);
  const full = Math.max(1, (model?.end ?? 1) - (model?.start ?? 0));
  const width = viewport && model ? clamp(viewport.end - viewport.start, 1, full) : full;
  const start = model ? clamp(viewport?.start ?? model.start, model.start, model.end - width) : 0;
  const fraction = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
  };
  const indexAt = (event: PointerEvent<HTMLDivElement>) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-timeline-record-index]") : null;
    const index = Number(target?.dataset.timelineRecordIndex);
    return target && Number.isFinite(index) ? index : null;
  };

  useEffect(() => { setViewport(null); onRangeChange(null); }, [actualTime]);
  useEffect(() => {
    if (!model || !viewport) return;
    if (viewport.end < model.start || viewport.start > model.end) setViewport(null);
  }, [model, viewport]);
  useEffect(() => {
    if (!model || !viewport || selectedIndex === null) return;
    const selected = model.spans.find((span) => span.index === selectedIndex);
    if (!selected || selected.start >= start && selected.start <= start + width) return;
    const nextStart = clamp(selected.start - width / 2, model.start, model.end - width);
    setViewport({ start: nextStart, end: nextStart + width });
  }, [model, selectedIndex]);
  useEffect(() => {
    const element = root.current;
    if (!element || !model) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = track.current?.getBoundingClientRect();
      if (!rect) return;
      const anchor = clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
      const nextWidth = clamp(width * Math.exp(event.deltaY * 0.0015), Math.min(actualTime ? 20 : 4, full), full);
      if (nextWidth >= full * 0.999) { setViewport(null); return; }
      const nextStart = clamp(start + anchor * (width - nextWidth), model.start, model.end - nextWidth);
      setViewport({ start: nextStart, end: nextStart + nextWidth });
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [model, start, width, full, actualTime]);

  if (!model) return <section ref={root} className={timelineCss.root} aria-label={t("会话时间线", "Session timeline")}><div className={timelineCss.plot}><div className={timelineCss.labels} aria-hidden="true"><span>{t("输入", "Input")}</span><span>{t("模型", "Model")}</span><span>{t("工具", "Tool")}</span></div><div className={timelineCss.track}><span className={timelineCss.empty}>{t("暂无轨迹", "No trajectory yet")}</span></div></div></section>;

  const domainStyle = { "--trajectory-domain-left": `${-(start - model.start) / width * 100}%`, "--trajectory-domain-width": `${full / width * 100}%` } as CSSProperties;
  const selection = draft ?? range;
  const selectionStyle = selection ? { "--trajectory-selection-left": `${(selection.start - start) / width * 100}%`, "--trajectory-selection-width": `${(selection.end - selection.start) / width * 100}%` } as CSSProperties : undefined;
  return <section ref={root} className={timelineCss.root} aria-label={t("会话时间线", "Session timeline")}><div className={timelineCss.plot}>
    <div className={timelineCss.labels} aria-hidden="true"><span>{t("输入", "Input")}</span><span>{t("模型", "Model")}</span><span>{t("工具", "Tool")}</span></div>
    <div ref={track} className={timelineCss.track} data-panning={panning || undefined} aria-label={t("时间线概览；拖动选择范围，滚轮缩放，右键拖动平移", "Timeline overview; drag to select, scroll to zoom, right drag to pan")} tabIndex={0}
      onKeyDown={(event) => { if (event.key === "Escape") { onRangeChange(null); setViewport(null); } }}
      onDoubleClick={() => onRangeChange(null)} onContextMenu={(event) => event.preventDefault()}
      onPointerDown={(event) => {
        if (event.button !== 0 && event.button !== 2) return;
        const time = start + fraction(event) * width;
        drag.current = { pointerId: event.pointerId, clientX: event.clientX, time, index: indexAt(event), pan: event.button === 2, viewportStart: start };
        event.currentTarget.setPointerCapture(event.pointerId);
        if (event.button === 2) setPanning(true);
        else setDraft({ start: time, end: time });
      }}
      onPointerMove={(event) => {
        setHover(fraction(event));
        const active = drag.current;
        if (!active || active.pointerId !== event.pointerId) return;
        if (active.pan) {
          if (!viewport) return;
          const rect = event.currentTarget.getBoundingClientRect();
          const nextStart = clamp(active.viewportStart - (event.clientX - active.clientX) / Math.max(1, rect.width) * width, model.start, model.end - width);
          setViewport({ start: nextStart, end: nextStart + width });
        } else {
          const time = start + fraction(event) * width;
          setDraft({ start: Math.min(active.time, time), end: Math.max(active.time, time) });
        }
      }}
      onPointerUp={(event) => {
        const active = drag.current;
        if (!active || active.pointerId !== event.pointerId) return;
        drag.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
        setPanning(false);
        setDraft(null);
        if (active.pan) { if (Math.abs(event.clientX - active.clientX) < 3) onRangeChange(null); return; }
        if (Math.abs(event.clientX - active.clientX) < 3 && active.index !== null) { onRangeChange(null); onSelect(active.index); return; }
        const time = start + fraction(event) * width;
        const minimum = Math.min(width, full / model.spans.length);
        const center = (active.time + time) / 2;
        const selectionWidth = Math.max(minimum, Math.abs(time - active.time));
        const nextStart = clamp(center - selectionWidth / 2, model.start, model.end - selectionWidth);
        onRangeChange({ start: nextStart, end: nextStart + selectionWidth });
      }}
      onPointerCancel={() => { drag.current = null; setDraft(null); setPanning(false); }}
      onPointerLeave={() => { if (!drag.current) setHover(null); }}>
      {hover !== null && !draft && <div className={timelineCss.hoverLine} style={{ "--trajectory-hover-left": `${hover * 100}%` } as CSSProperties} aria-hidden="true" />}
      {selectionStyle && <><div className={timelineCss.selection} style={selectionStyle} aria-hidden="true" /><div className={timelineCss.selectionEdges} style={selectionStyle} aria-hidden="true" /></>}
      <div className={timelineCss.turnBoundaries} style={domainStyle} aria-hidden="true">{model.boundaries.slice(1).map((boundary) => <span key={boundary.turn} className={timelineCss.turnBoundary} style={{ "--trajectory-turn-left": `${(boundary.time - model.start) / full * 100}%` } as CSSProperties} />)}</div>
      <div className={timelineCss.lanes} style={domainStyle}>{model.spans.map((span) => {
        const eventWidth = (span.end - span.start) / full * 100;
        return <button key={span.index} type="button" className={`${timelineCss.span} ${css.timelineButton}`} data-timeline-record-index={span.index} data-timeline-span={span.lane === 0 ? "user" : span.lane === 2 ? "tool" : "message"} data-equal-duration={actualTime && span.end === span.start || undefined} data-current={selectedIndex === span.index || undefined} data-error={span.error || undefined} data-selected={selection ? span.start <= selection.end && span.end >= selection.start ? "true" : "false" : undefined} data-search-match={matchingIndexes ? matchingIndexes.has(span.index) ? "true" : "false" : undefined} aria-label={t(`第 ${span.index} 条轨迹`, `Trajectory record ${span.index}`)} title={t(`第 ${span.index} 条 · ${actualTime ? new Date(span.start).toLocaleTimeString() : "事件顺序"}`, `Record ${span.index} · ${actualTime ? new Date(span.start).toLocaleTimeString() : "event order"}`)} style={{ "--trajectory-span-left": `${(span.start - model.start) / full * 100}%`, "--trajectory-span-width": `${eventWidth}%`, "--trajectory-span-gap": `min(${eventWidth * 0.08}%, 1px)`, "--trajectory-span-lane": span.lane } as CSSProperties} onClick={(event) => { if (event.detail === 0) onSelect(span.index); }} />;
      })}</div>
    </div>
  </div></section>;
}
