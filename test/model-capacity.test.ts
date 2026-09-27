import assert from "node:assert/strict";
import test from "node:test";
import { formatCapacity, parseCapacity } from "../shared/model-capacity.ts";

test("model capacities use DSH's decimal K/M notation", () => {
  assert.equal(parseCapacity("256K"), 256000);
  assert.equal(parseCapacity("1M"), 1000000);
  assert.equal(parseCapacity("2.3M"), 2300000);
  assert.equal(formatCapacity(256000), "256K");
  assert.equal(formatCapacity(1000000), "1M");
  assert.equal(parseCapacity(""), undefined);
  assert.ok(Number.isNaN(parseCapacity("12GiB")));
});
