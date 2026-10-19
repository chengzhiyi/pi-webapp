import assert from "node:assert/strict";
import test from "node:test";
import { sessionTimeLabel } from "../web/src/ui/workspace/session-time.ts";

const now = Date.parse("2026-10-18T12:00:00Z");
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
test("sidebar times use DSH compact units and the app locale", () => {
  for (const [minutes, en, zh] of [
    [0, "now", "刚刚"], [5, "5min", "5分钟"], [60, "1h", "1小时"],
    [1440, "1d", "1天"], [10080, "1wk", "1周"], [43200, "1mo", "1个月"], [525600, "1yr", "1年"],
  ] as const) {
    assert.equal(sessionTimeLabel(ago(minutes), now, "en"), en);
    assert.equal(sessionTimeLabel(ago(minutes), now, "zh"), zh);
  }
});
test("sidebar times hide invalid dates and clamp future clock skew", () => {
  assert.equal(sessionTimeLabel("invalid", now, "en"), "");
  assert.equal(sessionTimeLabel(ago(-10), now, "en"), "now");
});
