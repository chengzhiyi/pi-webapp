/** Pi projection of DSH's three-lane trajectory overview. */
export interface TimelineEvent {
  index: number;
  turn: number;
  kind: "user" | "message" | "tool";
  error?: boolean;
  timestamp: string;
  endTimestamp?: string;
}

export interface TimelineSpan {
  index: number;
  start: number;
  end: number;
  lane: number;
  error: boolean;
}

export interface TimelineModel {
  start: number;
  end: number;
  spans: TimelineSpan[];
  boundaries: { turn: number; time: number }[];
}

/** DSH uses one operation-wide slot per record in sequence mode. */
export function trajectoryTimeline(events: readonly TimelineEvent[], actualTime: boolean): TimelineModel | null {
  if (events.length === 0) return null;
  const firstValidTime = events.map((event) => Date.parse(event.timestamp)).find(Number.isFinite) ?? 0;
  const spans = events.map((event, offset) => {
    const started = Date.parse(event.timestamp);
    const start = actualTime && Number.isFinite(started) ? started : offset;
    const completed = event.endTimestamp ? Date.parse(event.endTimestamp) : NaN;
    return {
      index: event.index,
      start,
      end: actualTime && Number.isFinite(completed) && completed > start ? completed : actualTime ? start : offset + 1,
      lane: event.kind === "user" ? 0 : event.kind === "tool" ? 2 : 1,
      error: event.error === true,
    };
  });
  const boundaries = events.flatMap((event, offset) => offset === 0 || event.turn !== events[offset - 1]!.turn
    ? [{ turn: event.turn, time: spans[offset]!.start }] : []);
  const domainStart = actualTime ? Math.min(firstValidTime, ...spans.map((span) => span.start)) : 0;
  const lastEnd = Math.max(...spans.map((span) => span.end));
  // Leave room for the final point marker instead of clipping it at 100%.
  const domainEnd = actualTime ? lastEnd + Math.max(1, (lastEnd - domainStart) / 100) : events.length;
  return { start: domainStart, end: domainEnd, spans, boundaries };
}

export function timelineFocusIndexes(model: TimelineModel, start: number, end: number): Set<number> {
  return new Set(model.spans.filter((span) => span.start <= end && span.end >= start).map((span) => span.index));
}
