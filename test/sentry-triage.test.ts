import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
// @ts-ignore Development tooling is intentionally outside the runtime bundle.
import { collectIssues, normalizeInput, validateReport, renderReport, command } from "../scripts/sentry-triage.mjs";

const options = { project: "soft/pi-webapp", period: "7d", query: "is:unresolved !environment:sentry-verification", limit: 2, events: 3 };
const issue = { id: "123", shortId: "PI-WEBAPP-1", title: "edit failed", count: "4", userCount: 1, permalink: "https://sentry.io/issues/123/" };
const rawEvent = { event_id: "abc", release: "pi-webapp@0.1.11", contexts: { diagnostic: { failureKind: "unknown", summaryOmitted: true, toolName: "edit" } }, exception: { values: [{ type: "ToolResultFailure", value: "edit: unknown (unknown)", stacktrace: { frames: [{ filename: "app:///extension/tool-diagnostics.ts", lineno: 158, vars: { password: "secret" } }] } }] }, request: { cookies: "session-secret" }, user: { email: "private@example.com" } };

test("offline Sentry JSON retains diagnostic evidence without request data or frame variables", () => {
  const bundle = normalizeInput(rawEvent, options);
  assert.equal(bundle.issues.length, 1);
  assert.equal(bundle.issues[0].events[0].eventId, "abc");
  assert.equal(bundle.issues[0].events[0].contexts.diagnostic.failureKind, "unknown");
  const wire = JSON.stringify(bundle);
  for (const secret of ["session-secret", "private@example.com", "password", '"vars"']) assert.ok(!wire.includes(secret));
});

test("collector keeps partial failures visible and uses literal argument arrays for queries", async () => {
  const calls: string[][] = [];
  const bundle = await collectIssues(options, async (args: string[]) => {
    calls.push(args);
    if (args[1] === "list") return [issue, { ...issue, id: "456", shortId: "PI-WEBAPP-2" }];
    if (args.includes("soft/123")) return [{ eventID: "abc", contexts: rawEvent.contexts, entries: [{ type: "exception", data: rawEvent.exception }] }];
    throw new Error("event lookup unavailable");
  });
  assert.equal(bundle.issues.length, 2);
  assert.equal(bundle.issues[0].events[0].eventId, "abc");
  assert.equal(bundle.issues[1].events.length, 0);
  assert.ok(bundle.issues[1].collectionErrors.length);
  assert.ok(calls[0]!.includes(options.query));
  assert.equal(bundle.coverage.issueLimitReached, true);
});

test("a failed issue list is never converted into an empty successful report", async () => {
  await assert.rejects(collectIssues(options, async () => { throw new Error("Not authenticated"); }), /Not authenticated/);
});

test("malformed CLI JSON fails explicitly instead of losing issues", async () => {
  await assert.rejects(collectIssues(options, async () => ({ unexpected: [] })), /array/i);
  assert.throws(() => normalizeInput({ arbitrary: "text" }, options), /Sentry/i);
});

test("CLI envelope is accepted and a prompt reaches the child process through stdin", async () => {
  const bundle = await collectIssues(options, async (args: string[]) => args[1] === "list" ? { data: [issue], hasMore: true } : { data: [rawEvent] });
  assert.equal(bundle.issues[0].events[0].eventId, "abc");
  assert.equal(bundle.coverage.issueLimitReached, true);
  const child = await command(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], { input: "literal `prompt` $(never execute)" });
  assert.equal(child.stdout, "literal `prompt` $(never execute)");
});

test("failed Codex commands preserve diagnostics without copying them into the public error", async () => {
  const output = await mkdtemp(join(tmpdir(), "sentry-triage-log-"));
  try {
    const logPath = join(output, "codex.log");
    await assert.rejects(command(process.execPath, ["-e", "console.error('private diagnostic'); process.exitCode = 1"], { logPath }), (error: Error) => error.message.includes(logPath) && !error.message.includes("private diagnostic"));
    assert.ok((await readFile(logPath, "utf8")).includes("private diagnostic"));
  } finally { await rm(output, { recursive: true, force: true }); }
});

const finding = { issueId: "123", category: "insufficient_evidence", decision: "investigate", priority: "P2", confidence: "low", summary: "Cannot establish the edit failure cause", evidence: ["Event abc has no diagnostic summary"], codeReferences: [], nextSteps: ["Read the local edit result"], secondaryFindings: [] };

test("report rejects missing, duplicate or invented issue conclusions", () => {
  const bundle = normalizeInput({ issues: [{ issue, events: [rawEvent], collectionErrors: [] }] }, options);
  for (const findings of [[], [finding, finding], [{ ...finding, issueId: "999" }]]) {
    assert.throws(() => validateReport({ summary: "Triage", findings }, bundle));
  }
  assert.doesNotThrow(() => validateReport({ summary: "Triage", findings: [finding] }, bundle));
});

test("evidence-free defects and uncertain causes cannot become confirmed no-fix conclusions", () => {
  const bundle = normalizeInput({ issues: [{ issue, events: [rawEvent], collectionErrors: [] }] }, options);
  for (const bad of [
    { ...finding, category: "app_bug", decision: "fix", evidence: [] },
    { ...finding, category: "expected_tool_failure", decision: "no_fix", evidence: [] },
    { ...finding, decision: "no_fix" },
    { ...finding, category: "invented" },
  ]) assert.throws(() => validateReport({ summary: "Triage", findings: [bad] }, bundle));
});

test("a missing event sample requires investigation even if the issue title resembles a known failure", () => {
  const bundle = normalizeInput({ issues: [{ issue, events: [], collectionErrors: ["lookup failed"] }] }, options);
  assert.throws(() => validateReport({ summary: "Triage", findings: [{ ...finding, category: "expected_tool_failure", decision: "no_fix" }] }, bundle), /samples/);
  assert.doesNotThrow(() => validateReport({ summary: "Triage", findings: [finding] }, bundle));
});

test("Markdown shows secondary monitoring fixes separately from an uncertain edit cause", () => {
  const bundle = normalizeInput({ issues: [{ issue, events: [rawEvent], collectionErrors: ["event sample incomplete"] }] }, options);
  const report = { summary: "One issue needs evidence", findings: [{ ...finding, secondaryFindings: [{ category: "monitoring_gap", decision: "fix", summary: "Recognize common edit failures", evidence: ["extension/tool-diagnostics.ts:26"], nextSteps: ["Add safe classifications"] }] }] };
  validateReport(report, bundle);
  const markdown = renderReport(report, bundle);
  assert.ok(markdown.includes("monitoring_gap"));
  assert.ok(markdown.includes("event sample incomplete"));
  assert.ok(markdown.includes("https://sentry.io/issues/123/"));
  assert.ok(markdown.includes("investigate"));
});
