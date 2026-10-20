import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "../src/host/client/random-uuid.ts";

function replaceCrypto(t: TestContext, value: Partial<Crypto>): void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto")!;
  Object.defineProperty(globalThis, "crypto", { configurable: true, value });
  t.after(() => Object.defineProperty(globalThis, "crypto", descriptor));
}

test("UUID generation uses the native API when available", t => {
  const id = "00112233-4455-4677-8899-aabbccddeeff";
  replaceCrypto(t, { randomUUID: () => id });
  assert.equal(randomUUID(), id);
});

for (const [byte, expected] of [
  [0, "00000000-0000-4000-8000-000000000000"],
  [255, "ffffffff-ffff-4fff-bfff-ffffffffffff"],
] as const) {
  test(`UUID fallback preserves random bytes and sets version/variant bits for byte ${byte}`, t => {
    replaceCrypto(t, { getRandomValues: ((values: Uint8Array) => values.fill(byte)) as Crypto["getRandomValues"] });
    assert.equal(randomUUID(), expected);
  });
}

test("UUID fallback produces distinct v4 IDs using real browser-compatible randomness", t => {
  const getRandomValues = crypto.getRandomValues.bind(crypto);
  replaceCrypto(t, { getRandomValues });
  const ids = Array.from({ length: 100 }, () => randomUUID());
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
