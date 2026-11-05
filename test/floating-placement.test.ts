import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_PLACEMENT, anchorPoint, floatingWidth, nudgePlacement, parseFloatingPreference, resolvePlacement, serializeFloatingPreference, settlePlacement } from "../web/src/ui/conversation/floating-placement.ts";

const bounds = { width: 1200, height: 800 };
const bar = { width: 552, height: 44 };

test("the default placement is bottom centre, 16px above the bottom edge", () => {
  assert.deepEqual(resolvePlacement(DEFAULT_PLACEMENT, bounds, bar), { x: 324, y: 740 });
  assert.equal(floatingWidth(1200), 552);
  assert.equal(floatingWidth(2000), 640);
  assert.equal(floatingWidth(500), 320);
  assert.equal(floatingWidth(400), 376);
});

test("a release near an anchor snaps; elsewhere it keeps the offset from the nearest anchor", () => {
  const corner = anchorPoint("tr", bounds, bar);
  assert.deepEqual(settlePlacement({ x: corner.x - 30, y: corner.y + 20 }, bounds, bar), { anchor: "tr", dx: 0, dy: 0 });
  const free = settlePlacement({ x: 100, y: 400 }, bounds, bar);
  assert.equal(free.anchor, "bl");
  assert.deepEqual(resolvePlacement(free, bounds, bar), { x: 100, y: 400 });
});

test("a resize keeps the anchor relationship and never leaves the bounds", () => {
  const placement = { anchor: "br" as const, dx: -40, dy: -20 };
  assert.deepEqual(resolvePlacement(placement, bounds, bar), { x: 596, y: 720 });
  assert.deepEqual(resolvePlacement(placement, { width: 900, height: 500 }, bar), { x: 296, y: 420 });
  // An offset that would push the box outside clamps to the margin.
  assert.deepEqual(resolvePlacement({ anchor: "tl", dx: -500, dy: -500 }, bounds, bar), { x: 12, y: 12 });
});

test("narrow bounds dock only at the top or bottom centre", () => {
  const narrow = { width: 390, height: 700 };
  const full = { width: 366, height: 44 };
  assert.deepEqual(settlePlacement({ x: 0, y: 100 }, narrow, full), { anchor: "tc", dx: 0, dy: 0 });
  assert.deepEqual(settlePlacement({ x: 0, y: 500 }, narrow, full), { anchor: "bc", dx: 0, dy: 0 });
});

test("keyboard nudges move from the resolved box and clamp", () => {
  const moved = nudgePlacement(DEFAULT_PLACEMENT, { x: 16, y: 0 }, bounds, bar);
  assert.deepEqual(moved, { anchor: "bc", dx: 16, dy: 0 });
  assert.deepEqual(nudgePlacement(DEFAULT_PLACEMENT, { x: 0, y: 64 }, bounds, bar), { anchor: "bc", dx: 0, dy: 4 });
});

test("the stored preference round-trips and tolerates junk", () => {
  const value = { placement: { anchor: "tl" as const, dx: 4, dy: 8 }, collapsed: true };
  assert.deepEqual(parseFloatingPreference(serializeFloatingPreference(value)), value);
  assert.deepEqual(parseFloatingPreference("{"), { placement: DEFAULT_PLACEMENT, collapsed: false });
  assert.deepEqual(parseFloatingPreference(JSON.stringify({ anchor: "middle", dx: "x", collapsed: 1 })), { placement: DEFAULT_PLACEMENT, collapsed: false });
});
