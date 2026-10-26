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

const stressTitle = "100-element local switch: 20 warmups + 50 different-version controller/editor/worker cycles";
const stressReport = (results: unknown[] = [{ status: "passed" }], file = "hosted-stress.spec.ts") => ({
  suites: [{ file, specs: [{ title: stressTitle, tests: [{ results }] }] }], errors: [],
});

test("separate stress gate requires the real test to run once and pass cleanly", () => {
  assert.deepEqual(verifyHostedBrowserResults(stressReport(), "stress"), { bodyPassed: 1, cleanPassed: 1, diagnosticSkipped: 0, failures: [] });
  for (const results of [[], [{ status: "skipped" }], [{ status: "failed" }], [{ status: "timedOut" }], [{ status: "interrupted" }], [{ status: "failed" }, { status: "passed" }], [{ status: "passed" }, { status: "passed" }], [{ status: "passed", retry: 1 }]]) {
    assert.ok(verifyHostedBrowserResults(stressReport(results), "stress").failures.length > 0);
  }
  assert.ok(verifyHostedBrowserResults(stressReport([{ status: "passed", annotations: [{ type: "shutdown-failed-closed" }] }]), "stress").failures.length > 0);
  assert.ok(verifyHostedBrowserResults({ ...stressReport(), errors: [{ message: "runner failed" }] }, "stress").failures.length > 0);
  assert.ok(verifyHostedBrowserResults({ suites: [] }, "stress").failures.length > 0);
  assert.ok(verifyHostedBrowserResults(report(), "stress").failures.length > 0);
  assert.ok(verifyHostedBrowserResults(stressReport(undefined, "fake.spec.ts"), "stress").failures.length > 0);
  assert.ok(verifyHostedBrowserResults(stressReport(), "hosted").failures.length > 0); // Production gate not relaxed.
  // @ts-expect-error The CLI must reject an invalid runtime group too.
  assert.throws(() => verifyHostedBrowserResults(stressReport(), "typo"), /hosted or stress/);
});

test("stress cannot inherit the hosted-only diagnostic skip exception", () => {
  const value = stressReport();
  value.suites.push({ file: "hosted-transport.spec.ts", specs: [{ title: "diagnostic: HTTP/1.1 socket-pool evidence for the legacy per-view long polls", tests: [{ results: [{ status: "skipped" }] }] }] });
  const result = verifyHostedBrowserResults(value, "stress");
  assert.equal(result.diagnosticSkipped, 0);
  assert.equal(result.failures.length, 1);
});

test("empty or malformed reports and omitted production sizes are not acceptance evidence", () => {
  assert.throws(() => verifyHostedBrowserResults({}), /Playwright JSON/);
  assert.equal(verifyHostedBrowserResults({ suites: [] }).failures.length, 2);
  assert.equal(verifyHostedBrowserResults({ suites: [{ specs: production.slice(0, 1) }] }).failures.length, 1);
});
