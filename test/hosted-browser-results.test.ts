import test from "node:test";
import assert from "node:assert/strict";
import { verifyHostedBrowserResults } from "../scripts/verify-hosted-browser-results.mjs";

const production = [1440, 390].map(width => ({ title: `real hosted archive + complete host UI + retained SDK hot lifecycle at ${width}px`, tests: [{ results: [{ status: "passed" }] }] }));
const report = (specs: unknown[] = []) => ({ suites: [{ file: "hosted-parity.spec.ts", specs: [...production, ...specs] }], errors: [] });

test("hosted acceptance requires clean shutdown in addition to passed browser bodies", () => {
  assert.deepEqual(verifyHostedBrowserResults(report()), { bodyPassed: 2, cleanPassed: 2, diagnosticSkipped: 0, failures: [] });
  for (const annotationAtResult of [false, true]) {
    const annotations = [{ type: "shutdown-failed-closed", description: "Missing view flush acknowledgement" }];
    const value = report([{ title: "dirty reload", tests: [{ ...(!annotationAtResult ? { annotations } : {}), results: [{ status: "passed", ...(annotationAtResult ? { annotations } : {}) }] }] }]);
    const result = verifyHostedBrowserResults(value);
    assert.equal(result.bodyPassed, 3); assert.equal(result.cleanPassed, 2);
    assert.deepEqual(result.failures, ["dirty reload: shutdown was not acknowledged"]);
  }
});

test("only the named legacy transport diagnostic may skip, never a product gate", () => {
  const value = report([{ title: "A11 multiview", tests: [{ results: [{ status: "skipped" }] }] }]);
  value.suites.push({ file: "hosted-transport.spec.ts", specs: [{ title: "diagnostic: HTTP/1.1 socket-pool evidence for the legacy per-view long polls", tests: [{ results: [{ status: "skipped" }] }] }] } as any);
  const result = verifyHostedBrowserResults(value);
  assert.equal(result.diagnosticSkipped, 1); assert.equal(result.failures.length, 1);
  assert.match(result.failures[0]!, /A11 multiview/);
});

test("failed retries, missing results and global errors cannot manufacture an acceptance pass", () => {
  const value = report([
    { title: "retry", tests: [{ results: [{ status: "failed" }, { status: "passed" }] }] },
    { title: "missing", tests: [{ results: [] }] },
  ]);
  (value.errors as unknown[]).push({ message: "runner interrupted" });
  const result = verifyHostedBrowserResults(value);
  assert.equal(result.failures.length, 3); assert.equal(result.cleanPassed, 2);
});

test("empty or malformed reports and omitted production sizes are not acceptance evidence", () => {
  assert.throws(() => verifyHostedBrowserResults({}), /Playwright JSON/);
  assert.equal(verifyHostedBrowserResults({ suites: [] }).failures.length, 2);
  assert.equal(verifyHostedBrowserResults({ suites: [{ specs: production.slice(0, 1) }] }).failures.length, 1);
});
