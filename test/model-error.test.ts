import assert from "node:assert/strict";
import test from "node:test";
import { parseModelError } from "../src/host/client/model-error.ts";

const anthropic = '400 {"type":"error","error":{"type":"invalid_request_error","message":"Third-party apps now draw from your extra usage."},"request_id":"req_011Cgf"}';

test("unwraps a provider's status and JSON envelope", () => {
  const parsed = parseModelError(anthropic);
  assert.equal(parsed.message, "Third-party apps now draw from your extra usage.");
  assert.equal(parsed.status, 400);
  assert.equal(parsed.type, "invalid_request_error");
  assert.equal(parsed.requestId, "req_011Cgf");
  assert.equal(parsed.raw, anthropic);
});

test("reads OpenAI-style codes and leaves plain text alone", () => {
  const openai = parseModelError('429 {"error":{"message":"Quota exceeded","code":"insufficient_quota"}}');
  assert.equal(openai.message, "Quota exceeded");
  assert.equal(openai.type, "insufficient_quota");
  assert.deepEqual(parseModelError("socket hang up"), { message: "socket hang up", status: undefined, type: undefined, requestId: undefined, usageLimit: false, raw: "socket hang up" });
  assert.equal(parseModelError("500 {not json}").message, "500 {not json}");
  assert.equal(parseModelError("The usage limit has been reached").usageLimit, true);
});
