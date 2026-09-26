import assert from "node:assert/strict";
import test from "node:test";
import { timelineFocusIndexes, trajectoryTimeline } from "../web/src/ui/trajectory/timeline-model.ts";

const events = [
  { index: 1, turn: 1, kind: "user" as const, timestamp: "2026-09-26T10:00:00.000Z" },
  { index: 2, turn: 1, kind: "tool" as const, timestamp: "2026-09-26T10:00:01.000Z", endTimestamp: "2026-09-26T10:00:03.000Z" },
  { index: 3, turn: 2, kind: "message" as const, timestamp: "2026-09-26T10:00:04.000Z" },
];

test("sequence projection gives each record a slot and marks turn boundaries", () => {
  const model = trajectoryTimeline(events, false)!;
  assert.deepEqual(model.spans.map(({ start, end, lane }) => ({ start, end, lane })), [
    { start: 0, end: 1, lane: 0 },
    { start: 1, end: 2, lane: 2 },
    { start: 2, end: 3, lane: 1 },
  ]);
  assert.deepEqual(model.boundaries, [{ turn: 1, time: 0 }, { turn: 2, time: 2 }]);
  assert.deepEqual([...timelineFocusIndexes(model, 1.2, 1.8)], [2]);
});

test("recorded time draws a tool call through its result and leaves untimed records as points", () => {
  const model = trajectoryTimeline(events, true)!;
  assert.equal(model.spans[0]!.start, model.spans[0]!.end);
  assert.equal(model.spans[1]!.end - model.spans[1]!.start, 2000);
  assert.equal(model.end - model.start, 4040);
});
